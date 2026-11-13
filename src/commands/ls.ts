import type { Ctx } from '../context.js';
import { resolvedInstalled } from '../lock.js';
import type { DepEntry } from '../project.js';
import { DEP_KINDS } from '../project.js';
import { selectEntries } from '../select.js';
import { nameMatcher } from '../util/glob.js';
import { plural, table } from '../util/text.js';
import { prepare } from './shared.js';
import { splitDirsAndPackages } from './up.js';

function groupByName(entries: DepEntry[]): Map<string, DepEntry[]> {
  const m = new Map<string, DepEntry[]>();
  for (const e of entries) {
    if (!m.has(e.name)) m.set(e.name, []);
    m.get(e.name)!.push(e);
  }
  return new Map([...m.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** `depseek ls [pkg...]`: where a dependency is used and with which versions. */
export async function lsCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { dirs, packages } = splitDirsAndPackages(ctx, args);
  const prep = await prepare(ctx, dirs);
  if (!prep) return 1;
  if (ctx.opts.dep === undefined && ctx.config.dep === undefined) prep.selection.kinds = new Set(DEP_KINDS);
  const match = nameMatcher(packages);
  let entries = selectEntries(prep.result.projects, prep.selection);
  if (match) entries = entries.filter((e) => match(e.name));
  const groups = groupByName(entries);
  const { paint } = ctx.painter;

  if (ctx.opts.output === 'json') {
    const data = Object.fromEntries(
      [...groups].map(([name, es]) => [
        name,
        es.map((e) => ({ project: e.project.rel, section: e.section, spec: e.raw, installed: resolvedInstalled(e) })),
      ]),
    );
    ctx.out(JSON.stringify(data, null, 2));
    return 0;
  }
  if (!groups.size) {
    ctx.err(packages.length ? `No dependency matching ${packages.join(', ')}.` : 'No dependencies found.');
    return 1;
  }

  if (packages.length) {
    for (const [name, es] of groups) {
      const specs = new Set(es.filter((e) => e.kind !== 'peer').map((e) => e.raw));
      ctx.out(
        `${paint('accent', name)}  ${paint('dim', `${plural(specs.size, 'version')} in ${plural(new Set(es.map((e) => e.project)).size, 'project')}`)}`,
      );
      const rows = es
        .sort((a, b) => a.raw.localeCompare(b.raw) || a.project.rel.localeCompare(b.project.rel))
        .map((e) => {
          const inst = resolvedInstalled(e);
          return [
            specs.size > 1 && e.kind !== 'peer' ? paint('medium', e.raw) : e.raw,
            paint('path', e.project.relDir),
            paint('dim', e.section),
            inst ? paint('dim', `installed ${inst}`) : '',
            e.internal ? paint('hint', 'internal') : '',
          ];
        });
      ctx.out(table(rows, { indent: '  ' }));
      ctx.out();
    }
    return 0;
  }

  const rows = [...groups].map(([name, es]) => {
    const counts = new Map<string, number>();
    for (const e of es) if (e.kind !== 'peer') counts.set(e.raw, (counts.get(e.raw) ?? 0) + 1);
    const specs = [...counts].sort((a, b) => b[1] - a[1]).map(([s, n]) => (n > 1 ? `${s} ×${n}` : s));
    const differs = counts.size > 1;
    return [
      differs ? paint('medium', name) : name,
      paint('dim', plural(new Set(es.map((e) => e.project)).size, 'project')),
      differs ? specs.join(paint('dim', ', ')) : (specs[0] ?? paint('dim', '(peer only)')),
    ];
  });
  ctx.out(table(rows));
  ctx.out();
  ctx.out(
    paint(
      'dim',
      `${plural(groups.size, 'dependency', 'dependencies')}; highlighted ones use different versions — see depseek conflicts`,
    ),
  );
  return 0;
}
