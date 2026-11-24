import type { Ctx } from '../context.js';
import { selectEntries } from '../select.js';
import { findUnused, type UnusedDep, type UnusedResult } from '../unused.js';
import { nameMatcher, pathMatcher } from '../util/glob.js';
import { plural, table } from '../util/text.js';
import { list } from '../args.js';
import { prepare } from './shared.js';
import { splitDirsAndPackages } from './up.js';

/** Split candidates into "nothing mentions it" (high confidence) and "only comments/docs mention it". */
function tiers(us: UnusedDep[]): [UnusedDep[], UnusedDep[]] {
  return [us.filter((u) => !u.mentioned), us.filter((u) => u.mentioned)];
}

/** `depseek unused [pkg...]`: dependencies that no source file, script or tool config refers to. */
export async function unusedCommand(ctx: Ctx, args: string[]): Promise<number> {
  const { dirs, packages } = splitDirsAndPackages(ctx, args);
  const prep = await prepare(ctx, dirs);
  if (!prep) return 1;
  const { paint } = ctx.painter;
  const only = nameMatcher(packages);
  const ignore = nameMatcher(ctx.config.unused?.ignore);
  const selected = new Set(selectEntries(prep.result.projects, prep.selection));
  const exclude = pathMatcher([...(ctx.config.scan?.exclude ?? []), ...(list(ctx.opts.exclude) ?? [])]);

  const results: UnusedResult[] = [];
  for (const project of prep.result.projects) {
    const r = await findUnused(project, {
      kinds: new Set(['prod', 'dev', 'optional']),
      ignore: (n) => Boolean(ignore?.(n)) || Boolean(only && !only(n)),
      exclude,
      gitignore: (ctx.opts.gitignore as boolean | undefined) ?? ctx.config.scan?.gitignore,
    });
    r.unused = r.unused.filter((u) => selected.has(u.entry));
    results.push(r);
  }
  const hits = results.filter((r) => r.unused.length);
  const total = hits.reduce((n, r) => n + r.unused.length, 0);

  if (ctx.opts.output === 'json') {
    ctx.stdout(
      JSON.stringify(
        hits.map((r) => ({
          project: r.project.rel,
          unused: r.unused.map((u) => ({
            name: u.entry.name,
            section: u.entry.section,
            spec: u.entry.raw,
            reason: u.reason,
            mentioned: u.mentioned,
          })),
        })),
        null,
        2,
      ),
    );
    return total ? 1 : 0;
  }
  if (ctx.opts.output === 'markdown') {
    const md = (us: UnusedDep[]): string => us.map((u) => `- \`${u.entry.name}\` (${u.entry.section})`).join('\n');
    ctx.out(
      hits
        .map((r) => {
          const [absent, mentioned] = tiers(r.unused);
          return [
            `### ${r.project.rel}`,
            absent.length && `**Not referenced anywhere**\n\n${md(absent)}`,
            mentioned.length && `**Only mentioned in comments or docs** (check before removing)\n\n${md(mentioned)}`,
          ]
            .filter(Boolean)
            .join('\n\n');
        })
        .join('\n\n'),
    );
    return total ? 1 : 0;
  }

  if (!total) {
    ctx.out(paint('ok', `✔ No unused dependencies in ${plural(results.length, 'project')}.`));
    return 0;
  }
  const rows = (us: UnusedDep[]): string[][] =>
    us.map((u) => [
      u.entry.name,
      paint('dim', u.entry.raw),
      paint('dim', u.entry.section),
      u.reason === 'types-of-unused' ? paint('hint', 'types for an unused package') : '',
    ]);
  let mentionedTotal = 0;
  for (const r of hits) {
    const [absent, mentioned] = tiers(r.unused);
    mentionedTotal += mentioned.length;
    ctx.out(
      `${paint('accent', r.project.rel)}  ${paint('dim', plural(r.unused.length, 'unused dependency', 'unused dependencies'))}`,
    );
    if (absent.length) {
      ctx.out(paint('error', '  Not referenced anywhere'));
      ctx.out(table(rows(absent), { indent: '    ' }));
    }
    if (mentioned.length) {
      ctx.out(paint('medium', '  Only mentioned in comments or docs — check before removing'));
      ctx.out(table(rows(mentioned), { indent: '    ' }));
    }
    ctx.out();
  }
  ctx.out(
    paint(
      'dim',
      `${plural(total, 'unused dependency', 'unused dependencies')} in ${plural(hits.length, 'project')}${mentionedTotal ? `, ${mentionedTotal} only mentioned in comments or docs` : ''}. Static check, results are candidates: packages loaded by name (plugins, injected drivers, CLIs) can be false positives — list them in config "unused.ignore".`,
    ),
  );
  return 1;
}
