import { isTool } from '../project.js';
import type { Ctx } from '../context.js';
import { resolvedInstalled } from '../lock.js';
import { selectEntries } from '../select.js';
import { formatSpec } from '../spec.js';
import { plural } from '../util/text.js';
import type { Change } from '../write.js';
import { applyChanges } from './apply.js';
import { postWrite } from './post.js';
import { getFormat, prepare, printSummary } from './shared.js';
import semver from 'semver';

/** `depseek format --to <fmt> [--from-lock]`: rewrite range prefixes without changing versions. */
export async function formatCommand(ctx: Ctx, roots: string[]): Promise<number> {
  const to = getFormat(ctx, 'to');
  if (!to) {
    ctx.err('depseek format: --to <exact|tilde|caret|preserve|gte|x-range> is required.');
    return 2;
  }
  const prep = await prepare(ctx, roots);
  if (!prep) return 1;
  printSummary(ctx, prep.result);
  const fromLock = Boolean(ctx.opts.fromLock);
  const changes: Change[] = [];
  const skipped: string[] = [];
  for (const e of selectEntries(prep.result.projects, prep.selection)) {
    if (prep.selection.ignored(e.name) || isTool(e.kind)) continue;
    const s = e.spec;
    if (s.kind !== 'range' || !s.base) continue;
    let version = s.base;
    if (fromLock) {
      const installed = resolvedInstalled(e);
      if (installed && s.range && semver.satisfies(installed, s.range, { includePrerelease: true }))
        version = installed;
      else if (s.xRange || !s.simple) {
        skipped.push(`${e.project.relDir}: ${e.name}@${e.raw} (not installed)`);
        continue;
      }
    } else if ((s.xRange || !s.simple) && to !== 'x-range') {
      // "1.x" → "1.0.0" would silently narrow the range; needs the lock file.
      skipped.push(`${e.project.relDir}: ${e.name}@${e.raw} (use --from-lock)`);
      continue;
    }
    const newRaw = formatSpec(s, version, to);
    if (newRaw !== e.raw) changes.push({ entry: e, newRaw });
  }
  if (skipped.length) {
    ctx.err(ctx.painter.paint('warn', `⚠ Skipped ${plural(skipped.length, 'range')} that can't be converted safely:`));
    for (const s of skipped.slice(0, 10)) ctx.err(ctx.painter.paint('dim', `  ${s}`));
    if (skipped.length > 10) ctx.err(ctx.painter.paint('dim', `  … and ${skipped.length - 10} more`));
  }
  return applyChanges(ctx, changes, {
    command: `format --to ${to}`,
    after: (files) => postWrite(ctx, files, undefined, `chore(deps): write dependency versions as ${to}`),
  });
}
