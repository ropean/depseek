import { relative } from 'node:path';
import type { Ctx } from '../context.js';
import { toPosix, plural } from '../util/text.js';
import { dirtyFiles, planFileChanges, unifiedDiff, writeWithBackup, type Change, type FileChange } from '../write.js';

export interface ApplyOptions {
  /** Shown in the backup manifest, e.g. "up". */
  command: string;
  /** Called after writing, before returning (install, commit). */
  after?: (files: FileChange[]) => Promise<number> | number;
}

export function printDiff(ctx: Ctx, files: FileChange[]): void {
  for (const f of files) {
    ctx.out(unifiedDiff(f.project.rel, f.before, f.after, ctx.painter));
    ctx.out();
  }
}

/** Shared write pipeline: diff → dry-run stop → git check → backup → write. */
export async function applyChanges(ctx: Ctx, changes: Change[], opts: ApplyOptions): Promise<number> {
  const { paint } = ctx.painter;
  const files = planFileChanges(changes);
  if (!files.length) {
    ctx.out(paint('ok', '✓ Nothing to change.'));
    return 0;
  }
  const count = files.reduce((n, f) => n + f.changes.length, 0);
  if (ctx.opts.diff !== false || ctx.opts.dryRun) printDiff(ctx, files);

  if (ctx.opts.dryRun) {
    ctx.out(paint('hint', `Dry run: ${plural(count, 'change')} in ${plural(files.length, 'file')} — nothing written.`));
    return 0;
  }

  const gitCheck = (ctx.opts.gitCheck as boolean | undefined) ?? ctx.config.gitCheck ?? true;
  if (gitCheck) {
    const dirty = dirtyFiles(files.map((f) => f.project.file));
    if (dirty.length) {
      ctx.err(paint('error', `✖ Uncommitted changes in ${plural(dirty.length, 'file')}:`));
      for (const d of dirty) ctx.err(`  ${toPosix(relative(ctx.cwd, d))}`);
      ctx.err(
        paint(
          'dim',
          'Commit or stash them first, or pass --no-git-check (a backup is always made; `depseek undo` restores it).',
        ),
      );
      return 1;
    }
  }

  const id = writeWithBackup(files, { cwd: ctx.cwd, command: opts.command });
  ctx.out(
    paint('ok', `✓ Wrote ${plural(count, 'change')} to ${plural(files.length, 'file')}.`) +
      paint('dim', `  Undo with: depseek undo (${id.slice(0, 19)})`),
  );
  return opts.after ? opts.after(files) : 0;
}
