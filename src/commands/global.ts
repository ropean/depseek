import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Update } from '../analyze.js';
import type { Ctx } from '../context.js';
import { runCommand } from '../install.js';
import { interactiveSelect } from '../interactive.js';
import { extractDeps, type PackageManager, type Project } from '../project.js';
import { confirm } from '../prompt.js';
import { renderUpdates } from '../render/check.js';
import { buildSelection } from '../select.js';
import { printAnalysis } from './check.js';
import { analysisFails, createClient, errorOn, runAnalysis, type Prepared } from './shared.js';

const PMS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' }, (err, stdout) => {
      // `npm ls` exits 1 on extraneous/invalid packages but still prints the tree.
      if (err && !stdout) reject(new Error(`${cmd} ${args.join(' ')} failed: ${err.message}`));
      else resolve(String(stdout));
    });
  });
}

/** name → installed version from a global install directory (package.json + node_modules). */
export function readGlobalDir(dir: string): Record<string, string> {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) return {};
  const json = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> };
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries(json.dependencies ?? {})) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')) as {
        version?: string;
      };
      out[name] = pkg.version ?? spec;
    } catch {
      out[name] = spec.replace(/^[\^~]/, '');
    }
  }
  return out;
}

export interface GlobalList {
  deps: Record<string, string>;
  /** Packages installed from a local path / link: upgrading them from the registry would replace the link. */
  linked: string[];
}

/** `npm ls -g --json` / `pnpm ls -g --json` dependencies → name → version; linked packages listed apart. */
export function parseLsJson(text: string): GlobalList {
  const data = JSON.parse(text || '{}') as unknown;
  const trees = (Array.isArray(data) ? data : [data]) as {
    dependencies?: Record<string, { version?: string; resolved?: string }>;
  }[];
  const deps: Record<string, string> = {};
  const linked: string[] = [];
  for (const t of trees)
    for (const [name, d] of Object.entries(t.dependencies ?? {})) {
      if (d.resolved?.startsWith('file:') || d.resolved?.startsWith('link:')) linked.push(name);
      else if (d.version) deps[name] = d.version;
    }
  return { deps, linked };
}

export async function listGlobal(pm: PackageManager): Promise<GlobalList> {
  switch (pm) {
    case 'npm':
      return parseLsJson(await capture('npm', ['ls', '-g', '--depth=0', '--json']));
    case 'pnpm':
      return parseLsJson(await capture('pnpm', ['ls', '-g', '--depth=0', '--json']));
    case 'yarn':
      return { deps: readGlobalDir((await capture('yarn', ['global', 'dir'])).trim()), linked: [] };
    case 'bun':
      return {
        deps: readGlobalDir(join(process.env.BUN_INSTALL ?? join(homedir(), '.bun'), 'install', 'global')),
        linked: [],
      };
  }
}

export function globalInstallCommand(pm: PackageManager, specs: string[]): [string, string[]] {
  switch (pm) {
    case 'npm':
      return ['npm', ['install', '-g', ...specs]];
    case 'pnpm':
      return ['pnpm', ['add', '-g', ...specs]];
    case 'yarn':
      return ['yarn', ['global', 'add', ...specs]];
    case 'bun':
      return ['bun', ['add', '-g', ...specs]];
  }
}

/** A package.json-shaped project for the global packages, so the normal analysis applies. */
export function globalProject(pm: PackageManager, deps: Record<string, string>): Project {
  const json = { name: `global (${pm})`, dependencies: deps };
  const label = `global (${pm})`;
  const project: Project = {
    file: label,
    dir: process.cwd(),
    rel: label,
    relDir: label,
    root: process.cwd(),
    name: label,
    text: `${JSON.stringify(json, null, 2)}\n`,
    json,
    deps: [],
  };
  project.deps = extractDeps(project);
  return project;
}

/** `depseek -g`: check (and with -u / -i, install) global packages. */
export async function globalCommand(ctx: Ctx): Promise<number> {
  const { paint } = ctx.painter;
  const pm = ((ctx.opts.packageManager as string | undefined) ?? 'npm') as PackageManager;
  if (!PMS.includes(pm)) throw new Error(`-g supports ${PMS.join(', ')} (got "${pm}")`);
  const conds = errorOn(ctx);
  const { deps, linked } = await listGlobal(pm);
  const project = globalProject(pm, deps);
  if (ctx.opts.output !== 'json' && ctx.opts.output !== 'markdown') {
    ctx.out(paint('dim', `Checking ${Object.keys(deps).length} global ${pm} packages`));
    if (linked.length)
      ctx.out(paint('dim', `Skipping ${linked.length} linked from a local path: ${linked.join(', ')}`));
    ctx.out();
  }
  const selection = buildSelection({ ...ctx.opts, dep: 'prod', project: undefined, noRoot: false }, ctx.config);
  const prep: Prepared = {
    result: { roots: [], projects: [project], broken: [], warnings: [] },
    selection,
    client: createClient(ctx, ctx.cwd),
  };
  let a = await runAnalysis(ctx, prep);
  const writing = Boolean(ctx.opts.upgrade || ctx.opts.interactive);

  if (ctx.opts.interactive && a.updates.length) {
    if (!ctx.interactiveTTY) {
      ctx.err('Interactive mode needs a terminal (stdin and stdout must be a TTY).');
      return 1;
    }
    const picked = await interactiveSelect(ctx, a);
    if (!picked?.length) {
      ctx.out(paint('dim', 'Nothing installed.'));
      return 0;
    }
    a = { ...a, updates: picked };
    ctx.out(renderUpdates(ctx.painter, a, 'package', { showWarnings: true }));
  } else printAnalysis(ctx, a);

  const why = analysisFails(conds, a);
  const fail = (code: number): number => {
    if (why.length) ctx.err(paint('error', `✖ --error-on: ${why.join(', ')}`));
    return why.length ? code || 1 : code;
  };
  if (!a.updates.length) return fail(0);

  const specs = a.updates.map((u: Update) => `${u.name}@${u.target}`);
  const [cmd, args] = globalInstallCommand(pm, specs);
  const line = [cmd, ...args].join(' ');
  if (!writing) {
    if (ctx.opts.output !== 'json' && ctx.opts.output !== 'markdown') {
      ctx.out();
      ctx.out(paint('dim', `Run with -u to install, -i to pick, or yourself: ${line}`));
    }
    return fail(0);
  }
  ctx.out();
  if (ctx.opts.dryRun) {
    ctx.out(paint('hint', `Dry run — would run: ${line}`));
    return fail(0);
  }
  if (!ctx.opts.yes) {
    if (!ctx.interactiveTTY) {
      ctx.err(paint('error', `✖ Not a terminal; pass -y to run: ${line}`));
      return 1;
    }
    if (!(await confirm(`Run ${line}?`, true))) return fail(0);
  }
  ctx.out(paint('dim', `$ ${line}`));
  const r = await runCommand(cmd, args, ctx.cwd);
  if (r.code !== 0) {
    ctx.err(r.output.trim().split('\n').slice(-30).join('\n'));
    ctx.err(paint('error', `✖ ${cmd} exited with ${r.code}`));
    return 1;
  }
  ctx.out(paint('ok', `✓ Installed ${specs.length} global package${specs.length === 1 ? '' : 's'}.`));
  return fail(0);
}
