import { runScan, type Ctx } from '../context.js';
import { renderTree } from '../tree.js';

/** `depseek tree [dir...]` and `--list-files [--tree]`. */
export async function treeCommand(ctx: Ctx, roots: string[], asTree = true): Promise<number> {
  const result = await runScan(ctx, roots);
  if (ctx.opts.output === 'json') {
    ctx.out(
      JSON.stringify(
        result.projects.map((p) => ({
          file: p.rel,
          name: p.name,
          version: p.version,
          lock: p.lock?.name,
          packageManager: p.effectiveLock?.pm,
          workspaceRoot: p.workspaceRoot?.rel,
          workspaces: p.workspaces,
          dependencies: p.deps.length,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (!result.projects.length && !result.broken.length) {
    ctx.err('No package.json found.');
    return 1;
  }
  if (asTree) {
    ctx.out(renderTree(result, ctx.painter, { ascii: Boolean(ctx.opts.ascii), cwd: ctx.cwd }));
  } else {
    for (const p of result.projects) ctx.out(p.rel);
  }
  return 0;
}
