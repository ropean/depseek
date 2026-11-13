import { relative } from 'node:path';
import type { Ctx } from '../context.js';
import { relativeTime, toPosix } from '../util/text.js';
import { listBackups, undo } from '../write.js';

export function undoCommand(ctx: Ctx, args: string[]): number {
  const { paint } = ctx.painter;
  if (ctx.opts.list) {
    const all = listBackups();
    if (!all.length) ctx.out('No backups.');
    for (const b of all) {
      ctx.out(
        `${paint('accent', b.id)}  ${paint('dim', relativeTime(b.createdAt))}  depseek ${b.command}  ${paint('dim', `${b.files.length} file(s) in ${b.cwd}`)}`,
      );
    }
    return 0;
  }
  const r = undo(args[0], Boolean(ctx.opts.force));
  if (!r) {
    ctx.err(args[0] ? `No backup matching "${args[0]}".` : 'Nothing to undo.');
    return 1;
  }
  const rel = (f: string): string => toPosix(relative(ctx.cwd, f)) || f;
  if (!r.restored.length) {
    ctx.err(paint('error', `✖ These files changed after "depseek ${r.manifest.command}" wrote them:`));
    for (const f of r.modified) ctx.err(`  ${rel(f)}`);
    ctx.err(paint('dim', 'Re-run with --force to restore anyway.'));
    return 1;
  }
  ctx.out(
    paint(
      'ok',
      `✓ Restored ${r.restored.length} file(s) from "depseek ${r.manifest.command}" (${relativeTime(r.manifest.createdAt)}):`,
    ),
  );
  for (const f of r.restored) ctx.out(`  ${rel(f)}`);
  ctx.out(paint('dim', 'Lock files are not restored — run your package manager install if needed.'));
  return 0;
}
