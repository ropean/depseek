import type { Analysis } from '../analyze.js';
import { findConflicts } from '../conflicts.js';
import { selectEntries } from '../select.js';
import type { Ctx } from '../context.js';
import { renderUpdates, updatesToJson, updatesToMarkdown, updatesToNcuJson, type GroupBy } from '../render/check.js';
import { analysisFails, errorOn, exactFormatHint, prepare, printSummary, runAnalysis } from './shared.js';

export function getGroupBy(ctx: Ctx): GroupBy {
  const g = (ctx.opts.groupBy as string | undefined) ?? ctx.config.groupBy ?? 'package';
  if (!['package', 'project', 'level'].includes(g))
    throw new Error(`Unknown --group-by "${g}" (expected package, project, level)`);
  return g as GroupBy;
}

export function printAnalysis(ctx: Ctx, a: Analysis): void {
  const ncuJson = ctx.opts.ncuJson as 'all' | 'deps' | 'upgraded' | undefined;
  if (ncuJson) ctx.stdout(JSON.stringify(updatesToNcuJson(a, ncuJson), null, 2));
  else if (ctx.opts.output === 'json') ctx.stdout(JSON.stringify(updatesToJson(a), null, 2));
  else if (ctx.opts.output === 'markdown') ctx.out(updatesToMarkdown(a));
  else ctx.out(renderUpdates(ctx.painter, a, getGroupBy(ctx)));
}

export async function checkCommand(ctx: Ctx, roots: string[]): Promise<number> {
  const conds = errorOn(ctx);
  const prep = await prepare(ctx, roots);
  if (!prep) return 1;
  printSummary(ctx, prep.result);
  const a = await runAnalysis(ctx, prep);
  printAnalysis(ctx, a);
  if (ctx.opts.output !== 'json' && ctx.opts.output !== 'markdown' && a.updates.length && !ctx.opts.upgrade) {
    ctx.out();
    ctx.out(ctx.painter.paint('dim', 'Run with -u to write, -i to pick interactively, --dry-run to preview the diff.'));
    const hint = exactFormatHint(ctx, a);
    if (hint) ctx.out(ctx.painter.paint('hint', hint));
  }
  const why = analysisFails(conds, a);
  if (conds.has('conflicts')) {
    const cfg = ctx.config.conflicts ?? {};
    const conflicts = findConflicts(selectEntries(prep.result.projects, prep.selection), {
      ignore: cfg.ignore,
      groups: cfg.groups,
    });
    if (conflicts.some((c) => c.severity !== 'hint')) why.push('version conflicts');
  }
  if (why.length) {
    ctx.err(ctx.painter.paint('error', `✖ --error-on: ${why.join(', ')}`));
    return 1;
  }
  return 0;
}
