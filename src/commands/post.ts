import { relative } from 'node:path';
import type { Analysis } from '../analyze.js';
import type { Ctx } from '../context.js';
import { installTargets, lockFilesIn, runInstalls } from '../install.js';
import type { PackageManager } from '../project.js';
import { confirm } from '../prompt.js';
import { toPosix } from '../util/text.js';
import { gitCommit, type FileChange } from '../write.js';
import { mergeRows } from '../render/check.js';

export function commitMessage(a: Pick<Analysis, 'updates'>): string {
  const rows = mergeRows(a.updates);
  const names = [...new Set(rows.map((r) => r.name))];
  const title =
    names.length <= 3 ? `chore(deps): update ${names.join(', ')}` : `chore(deps): update ${names.length} packages`;
  const body = rows.map((r) => `- ${r.name} ${r.raw} → ${r.newRaw} (${r.projects.map((p) => p.relDir).join(', ')})`);
  return `${title}\n\n${body.join('\n')}\n`;
}

export function installMode(ctx: Ctx): 'always' | 'prompt' | 'never' {
  const m = (ctx.opts.install as string | undefined) ?? ctx.config.install ?? 'prompt';
  if (!['always', 'prompt', 'never'].includes(m))
    throw new Error(`Unknown --install "${m}" (expected always, prompt, never)`);
  return m as 'always' | 'prompt' | 'never';
}

/** Run install where needed. Returns the lock files that may have changed (for committing). */
export async function maybeInstall(ctx: Ctx, files: FileChange[]): Promise<{ code: number; locks: string[] }> {
  const { paint } = ctx.painter;
  const mode = installMode(ctx);
  const targets = installTargets(
    files.map((f) => f.project),
    (ctx.config.packageManager as PackageManager | undefined) ?? 'bun',
  );
  if (mode === 'never' || !targets.length) return { code: 0, locks: [] };
  const describe = targets.map((t) => `${t.pm} in ${toPosix(relative(ctx.cwd, t.dir)) || '.'}`).join(', ');
  if (mode === 'prompt') {
    if (ctx.opts.yes) {
      /* proceed */
    } else if (!ctx.interactiveTTY) {
      ctx.out(paint('dim', `Lock files not updated. Run install (${describe}) or pass --install always.`));
      return { code: 0, locks: [] };
    } else if (!(await confirm(`Run install? (${describe})`, true))) {
      return { code: 0, locks: [] };
    }
  }
  ctx.out(paint('dim', `Installing: ${describe}…`));
  const results = await runInstalls(targets, 4, (r) => {
    const where = toPosix(relative(ctx.cwd, r.target.dir)) || '.';
    ctx.out(
      r.ok
        ? paint('ok', `  ✓ ${r.target.pm} install  ${where}  ${paint('dim', `${(r.ms / 1000).toFixed(1)}s`)}`)
        : paint('error', `  ✖ ${r.target.pm} install  ${where}  (exit ${r.code})`),
    );
  });
  const failed = results.filter((r) => !r.ok);
  for (const f of failed) {
    ctx.err(paint('error', `── ${f.target.pm} install in ${toPosix(relative(ctx.cwd, f.target.dir)) || '.'} ──`));
    ctx.err(f.output.trim().split('\n').slice(-20).join('\n'));
  }
  return { code: failed.length ? 1 : 0, locks: results.filter((r) => r.ok).flatMap((r) => lockFilesIn(r.target.dir)) };
}

export async function postWrite(
  ctx: Ctx,
  files: FileChange[],
  a?: Pick<Analysis, 'updates'>,
  message?: string,
): Promise<number> {
  const { code, locks } = await maybeInstall(ctx, files);
  if (ctx.opts.commit) {
    const msg = message ?? (a ? commitMessage(a) : 'chore(deps): update package.json');
    const results = gitCommit([...files.map((f) => f.project.file), ...locks], msg);
    for (const r of results) {
      const where = toPosix(relative(ctx.cwd, r.root)) || '.';
      if (r.ok) ctx.out(ctx.painter.paint('ok', `✓ Committed in ${where}: ${msg.split('\n')[0]}`));
      else ctx.err(ctx.painter.paint('error', `✖ git commit failed in ${where}: ${r.error}`));
    }
    if (!results.length)
      ctx.err(ctx.painter.paint('warn', '⚠ --commit: no git repository found for the changed files.'));
    if (results.some((r) => !r.ok)) return 1;
  }
  return code;
}
