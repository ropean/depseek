import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Update } from '../analyze.js';
import { LEVELS } from '../versions.js';
import type { Ctx } from '../context.js';
import { interactiveSelect } from '../interactive.js';
import { renderUpdates } from '../render/check.js';
import { applyChanges } from './apply.js';
import { printAnalysis } from './check.js';
import { analysisFails, errorOn, parsePackageArgs, prepare, printSummary, runAnalysis } from './shared.js';
import { postWrite } from './post.js';

/**
 * Split `up` positionals into directories and package specs. Paths (./x, /x, ~/x, a/b) and
 * existing directories holding a package.json are directories; everything else is a package.
 */
export function splitDirsAndPackages(ctx: Ctx | string, args: string[]): { dirs: string[]; packages: string[] } {
  const cwd = typeof ctx === 'string' ? ctx : ctx.cwd;
  const dirs: string[] = [];
  const packages: string[] = [];
  for (const a of args) {
    const abs = resolve(cwd, a);
    const isDir = existsSync(abs) && statSync(abs).isDirectory();
    const looksLikePath = /^(\.|\/|~|[A-Za-z]:[\\/])/.test(a) || (a.includes('/') && !a.startsWith('@'));
    if (isDir && (looksLikePath || existsSync(join(abs, 'package.json')))) dirs.push(a);
    else packages.push(a);
  }
  return { dirs, packages };
}

/** `depseek -u`, `depseek up [pkg[@version]...]`. */
export async function upCommand(ctx: Ctx, args: string[], fromCheck = false): Promise<number> {
  const { dirs, packages } = fromCheck ? { dirs: args, packages: [] } : splitDirsAndPackages(ctx, args);
  const conds = errorOn(ctx);
  const prep = await prepare(ctx, dirs);
  if (!prep) return 1;
  printSummary(ctx, prep.result);
  const explicit = packages.length ? parsePackageArgs(packages) : undefined;
  let a = await runAnalysis(ctx, prep, { explicit });
  if (explicit) {
    const found = new Set(a.entries.map((e) => e.name));
    for (const name of explicit.keys())
      if (!found.has(name)) ctx.err(ctx.painter.paint('warn', `⚠ ${name} is not used by any selected package.json`));
  }
  if (a.errors.size && explicit) {
    for (const [n, e] of a.errors) ctx.err(ctx.painter.paint('error', `✖ ${n}: ${e}`));
    return 1;
  }

  if (ctx.opts.interactive) {
    if (!ctx.interactiveTTY) {
      ctx.err('Interactive mode needs a terminal (stdin and stdout must be a TTY).');
      return 1;
    }
    if (!a.updates.length) {
      printAnalysis(ctx, a);
      return 0;
    }
    const picked = await interactiveSelect(ctx, a);
    if (!picked?.length) {
      ctx.out(ctx.painter.paint('dim', 'Nothing written.'));
      return 0;
    }
    a = { ...a, updates: picked };
    ctx.out(renderUpdates(ctx.painter, a, 'package', { showWarnings: true }));
  } else {
    printAnalysis(ctx, a);
  }
  ctx.out();
  if (!a.updates.length) return 0;

  const code = await writeUpdates(ctx, a.updates, `up ${args.join(' ')}`.trim());
  const why = analysisFails(conds, a);
  if (why.length) {
    ctx.err(ctx.painter.paint('error', `✖ --error-on: ${why.join(', ')}`));
    return code || 1;
  }
  return code;
}

/** Write updates; with --commit=level, one write → install → commit round per level. */
export async function writeUpdates(ctx: Ctx, updates: Update[], command: string): Promise<number> {
  const batches =
    ctx.opts.commit === 'level'
      ? LEVELS.map((l) => updates.filter((u) => u.level === l)).filter((b) => b.length)
      : [updates];
  let code = 0;
  for (const batch of batches) {
    const c = await applyChanges(
      ctx,
      batch.map((u) => ({ entry: u.entry, newRaw: u.newRaw })),
      { command, after: (files) => postWrite(ctx, files, { updates: batch }) },
    );
    if (c && batches.length > 1 && !ctx.opts.dryRun) return c;
    code ||= c;
  }
  return code;
}
