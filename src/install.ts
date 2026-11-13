import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { LOCK_FILES, type PackageManager, type Project } from './project.js';
import { mapLimit } from './util/pool.js';

export interface InstallTarget {
  dir: string;
  pm: PackageManager;
  projects: Project[];
}

export interface InstallResult {
  target: InstallTarget;
  ok: boolean;
  code: number | null;
  output: string;
  ms: number;
}

/** Where to run install for a set of changed projects: one run per lock-file directory. */
export function installTargets(projects: Project[], defaultPm: PackageManager = 'bun'): InstallTarget[] {
  const targets = new Map<string, InstallTarget>();
  for (const p of projects) {
    let top = p;
    while (top.workspaceRoot) top = top.workspaceRoot;
    const lock = p.effectiveLock ?? top.lock;
    const dir = lock ? dirname(lock.file) : top.dir;
    const pm = lock?.pm ?? defaultPm;
    const t = targets.get(dir);
    if (t) t.projects.push(p);
    else targets.set(dir, { dir, pm, projects: [p] });
  }
  return [...targets.values()];
}

export function installCommand(pm: PackageManager): [string, string[]] {
  return [pm, ['install']];
}

export function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const child = win
      ? spawn([cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), {
          cwd,
          shell: true,
          env: { ...process.env, ...env },
        })
      : spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ code: -1, output: `${output}${e.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

export function runShell(command: string, cwd: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: '0' } });
    let output = '';
    child.stdout?.on('data', (d) => (output += d));
    child.stderr?.on('data', (d) => (output += d));
    child.on('error', (e) => resolve({ code: -1, output: `${output}${e.message}` }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

export async function runInstalls(
  targets: InstallTarget[],
  concurrency = 4,
  onDone?: (r: InstallResult) => void,
): Promise<InstallResult[]> {
  return mapLimit(targets, concurrency, async (target) => {
    const start = Date.now();
    const [cmd, args] = installCommand(target.pm);
    const { code, output } = await runCommand(cmd, args, target.dir, { FORCE_COLOR: '0' });
    const r = { target, ok: code === 0, code, output, ms: Date.now() - start };
    onDone?.(r);
    return r;
  });
}

/** Lock files present in an install directory (after install, for committing). */
export function lockFilesIn(dir: string): string[] {
  return LOCK_FILES.map(([name]) => join(dir, name)).filter((f) => existsSync(f));
}
