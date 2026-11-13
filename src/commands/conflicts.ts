import { resolveFormat } from '../analyze.js';
import {
  alignTarget,
  findConflicts,
  findPeerProblems,
  majorKey,
  type AlignStrategy,
  type Conflict,
} from '../conflicts.js';
import type { Ctx } from '../context.js';
import type { DepEntry } from '../project.js';
import { confirm } from '../prompt.js';
import { RegistryError } from '../registry.js';
import { conflictsToJson, conflictsToMarkdown, renderConflicts } from '../render/conflicts.js';
import { selectEntries } from '../select.js';
import { formatSpec } from '../spec.js';
import { nameMatcher } from '../util/glob.js';
import { plural } from '../util/text.js';
import { pickTarget, resolveRange } from '../versions.js';
import type { Change } from '../write.js';
import { applyChanges } from './apply.js';
import { postWrite } from './post.js';
import { errorOn, getFormat, prepare, printSummary, type Prepared } from './shared.js';
import { splitDirsAndPackages } from './up.js';

const STRATEGIES: readonly string[] = ['highest', 'lowest', 'most-used', 'latest'];

function bucketsOf(c: Conflict, allowMajor: boolean): DepEntry[][] {
  const all = c.variants.flatMap((v) => v.entries);
  if (allowMajor) return [all];
  const m = new Map<string, DepEntry[]>();
  for (const e of all) {
    const k = e.spec.base ? majorKey(e.spec.base) : e.raw;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(e);
  }
  return [...m.values()];
}

const variantsOf = (entries: DepEntry[]) => {
  const m = new Map<string, { raw: string; base?: string; entries: DepEntry[] }>();
  for (const e of entries) {
    const v = m.get(e.raw) ?? { raw: e.raw, base: e.spec.base, entries: [] };
    v.entries.push(e);
    m.set(e.raw, v);
  }
  return [...m.values()];
};

async function planFix(
  ctx: Ctx,
  prep: Prepared,
  conflicts: Conflict[],
  align: string,
): Promise<{ changes: Change[]; notes: string[] } | undefined> {
  const { paint } = ctx.painter;
  const explicit = !STRATEGIES.includes(align);
  const cliFormat = getFormat(ctx);
  const changes: Change[] = [];
  const notes: string[] = [];
  for (const c of conflicts) {
    if (c.type === 'section') continue;
    let allowMajor = Boolean(ctx.opts.allowMajor) || explicit;
    const crossMajor = c.type === 'major';
    if (crossMajor && !allowMajor && ctx.opts.interactive && ctx.interactiveTTY) {
      allowMajor = await confirm(
        `${c.name}: align across major versions (${c.variants.map((v) => v.raw).join(', ')})?`,
        false,
      );
    }
    if (crossMajor && !allowMajor) notes.push(`${c.name}: major lines kept apart (use --allow-major or -i)`);
    for (const bucket of bucketsOf(c, allowMajor)) {
      // A major line written one way only has nothing to align (don't rewrite `^18.3.1` → `18.3.1`).
      if (!explicit && align !== 'latest' && variantsOf(bucket).length < 2) continue;
      let target: string | undefined;
      if (explicit || align === 'latest') {
        let meta;
        try {
          meta = await prep.client.get(c.name);
        } catch (e) {
          notes.push(`${c.name}: ${(e as RegistryError).message}`);
          continue;
        }
        if (explicit) {
          target = resolveRange(meta, align);
          if (!target) {
            ctx.err(paint('error', `✖ ${c.name}@${align} does not exist in the registry`));
            return undefined;
          }
        } else {
          const highest = alignTarget(variantsOf(bucket), 'highest');
          target =
            pickTarget(meta, highest, allowMajor ? 'latest' : 'minor', undefined, {
              cooldownDays: ctx.config.cooldown,
            }) ?? highest;
        }
      } else {
        target = alignTarget(variantsOf(bucket), align as Exclude<AlignStrategy, 'latest'>);
      }
      if (!target) continue;
      for (const e of bucket) {
        const newRaw = formatSpec(e.spec, target, resolveFormat(e, cliFormat, ctx.config.format));
        if (newRaw !== e.raw) changes.push({ entry: e, newRaw });
      }
    }
  }
  return { changes, notes };
}

/** `depseek conflicts [pkg...] [--fix --align <strategy|version>]` */
export async function conflictsCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { dirs, packages } = splitDirsAndPackages(ctx, args);
  const conds = errorOn(ctx);
  const prep = await prepare(ctx, dirs);
  if (!prep) return 1;
  const entries = selectEntries(prep.result.projects, prep.selection);
  const cfg = ctx.config.conflicts ?? {};
  let conflicts = findConflicts(entries, { ignore: cfg.ignore, groups: cfg.groups });
  const match = nameMatcher(packages);
  if (match) conflicts = conflicts.filter((c) => match(c.name));
  const peers = findPeerProblems(prep.result.projects, entries).filter((p) => !match || match(p.peer) || match(p.pkg));
  const align = (ctx.opts.align as string | undefined) ?? cfg.align ?? 'highest';
  if (!STRATEGIES.includes(align) && packages.length !== 1) {
    ctx.err(`--align <version> needs exactly one package: depseek conflicts <pkg> --fix --align ${align}`);
    return 2;
  }

  if (ctx.opts.output === 'json') ctx.out(JSON.stringify(conflictsToJson(conflicts, peers), null, 2));
  else if (ctx.opts.output === 'markdown') ctx.out(conflictsToMarkdown(conflicts, peers));
  else {
    printSummary(ctx, prep.result);
    const allowMajor = Boolean(ctx.opts.allowMajor);
    const suggestion = (c: Conflict): string | undefined => {
      if (c.type === 'section') return undefined;
      if (!STRATEGIES.includes(align)) return align;
      if (align === 'latest') return 'latest from registry';
      // Without --allow-major each major line is aligned separately: show the most-used line's target.
      const line = c.variants[0]!.base ? majorKey(c.variants[0]!.base) : undefined;
      const pool = allowMajor || !line ? c.variants : c.variants.filter((v) => v.base && majorKey(v.base) === line);
      const v = alignTarget(pool, align as Exclude<AlignStrategy, 'latest'>);
      if (!v) return undefined;
      const sample = pool[0]!.entries[0]!;
      const shown = formatSpec(sample.spec, v, resolveFormat(sample, getFormat(ctx), ctx.config.format));
      return c.type === 'major' && !allowMajor ? `${shown} (within ${line}.x; --allow-major for all)` : shown;
    };
    ctx.out(renderConflicts(ctx.painter, conflicts, peers, suggestion));
  }

  if (ctx.opts.fix) {
    const plan = await planFix(ctx, prep, conflicts, align);
    if (!plan) return 1;
    ctx.out();
    for (const n of plan.notes) ctx.out(ctx.painter.paint('dim', `• ${n}`));
    if (plan.notes.length) ctx.out();
    const names = [...new Set(plan.changes.map((c) => c.entry.name))];
    const code = await applyChanges(ctx, plan.changes, {
      command: `conflicts --fix --align ${align}`,
      after: (files) =>
        postWrite(
          ctx,
          files,
          undefined,
          `chore(deps): align versions of ${names.length <= 3 ? names.join(', ') : plural(names.length, 'package')}\n\n${plan.changes.map((c) => `- ${c.entry.project.relDir}: ${c.entry.name} ${c.entry.raw} → ${c.newRaw}`).join('\n')}\n`,
        ),
    });
    if (code) return code;
  } else if (
    conflicts.some((c) => c.severity !== 'hint') &&
    ctx.opts.output !== 'json' &&
    ctx.opts.output !== 'markdown'
  ) {
    ctx.out();
    ctx.out(
      ctx.painter.paint(
        'dim',
        'Align them with: depseek conflicts --fix [--align highest|lowest|most-used|latest] [--allow-major]',
      ),
    );
  }
  if (conds.has('conflicts') && (conflicts.some((c) => c.severity !== 'hint') || peers.length)) {
    ctx.err(ctx.painter.paint('error', '✖ --error-on: version conflicts'));
    return 1;
  }
  return 0;
}
