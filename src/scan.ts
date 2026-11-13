import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { isIgnored, loadIgnoreFile, type IgnoreFile } from './gitignore.js';
import { extractDeps, LOCK_FILES, parsePnpmWorkspace, workspaceGlobs, type LockInfo, type Project } from './project.js';
import { globToRegExp, pathMatcher } from './util/glob.js';
import { toPosix } from './util/text.js';

export const DEFAULT_IGNORE: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.output',
  '.wrangler',
  '.turbo',
  'coverage',
  '.cache',
  '.svelte-kit',
  '.nuxt',
  '.vercel',
  // Templates and fixtures usually shouldn't be touched; drop from `ignore` in config to include them.
  'fixtures',
  '__fixtures__',
  'templates',
  'examples',
];

export interface ScanOptions {
  /** Directories to scan (default: cwd). */
  roots?: string[];
  recursive?: boolean;
  /** Max directory depth below each root (0 = root only). */
  depth?: number;
  include?: string[];
  exclude?: string[];
  /** Directory/file names (or globs) skipped everywhere. Defaults to DEFAULT_IGNORE. */
  ignore?: readonly string[];
  gitignore?: boolean;
  followSymlinks?: boolean;
  cwd?: string;
}

export interface BrokenFile {
  file: string;
  rel: string;
  error: string;
}

export interface ScanResult {
  roots: string[];
  projects: Project[];
  broken: BrokenFile[];
  warnings: string[];
}

function relFromCwd(cwd: string, abs: string): string {
  const r = toPosix(relative(cwd, abs));
  return r || '.';
}

function findLock(dir: string): LockInfo | undefined {
  for (const [name, pm] of LOCK_FILES) {
    const file = join(dir, name);
    if (existsSync(file)) return { pm, file, name };
  }
  return undefined;
}

/** .gitignore files from the enclosing git repository down to (not including) `root`. */
function ancestorIgnores(root: string): IgnoreFile[] {
  const dirs: string[] = [];
  let d = dirname(root);
  for (;;) {
    dirs.push(d);
    if (existsSync(join(d, '.git'))) break;
    const up = dirname(d);
    if (up === d) return []; // not inside a git repo → ancestors don't apply
    d = up;
  }
  if (existsSync(join(root, '.git'))) return [];
  return dirs
    .reverse()
    .map(loadIgnoreFile)
    .filter((x): x is IgnoreFile => Boolean(x));
}

export async function scan(opts: ScanOptions = {}): Promise<ScanResult> {
  const cwd = opts.cwd ?? process.cwd();
  const roots = (opts.roots?.length ? opts.roots : ['.']).map((r) => resolve(cwd, r));
  const maxDepth = opts.recursive === false ? 0 : (opts.depth ?? Infinity);
  const ignoreNames = (opts.ignore ?? DEFAULT_IGNORE).map((g) => globToRegExp(g));
  const excluded = opts.exclude?.length ? pathMatcher(opts.exclude) : undefined;
  const included = opts.include?.length ? pathMatcher(opts.include) : undefined;
  const useGitignore = opts.gitignore !== false;

  const files = new Map<string, { file: string; root: string }>();
  const warnings: string[] = [];
  const visitedReal = new Set<string>();

  const walk = async (dir: string, root: string, depth: number, ignores: IgnoreFile[]): Promise<void> => {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch {
      return;
    }
    if (visitedReal.has(real)) return;
    visitedReal.add(real);

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      warnings.push(`Cannot read ${relFromCwd(cwd, dir)}: ${(e as Error).message}`);
      return;
    }
    const own = useGitignore ? loadIgnoreFile(dir) : undefined;
    const stack = own ? [...ignores, own] : ignores;
    const relToRoot = (abs: string): string => toPosix(relative(root, abs));

    if (entries.some((e) => e.name === 'package.json' && (e.isFile() || e.isSymbolicLink()))) {
      const file = join(dir, 'package.json');
      const rel = relToRoot(file);
      const ok =
        (!included || included(rel) || included(relToRoot(dir) || '.')) &&
        !excluded?.(rel) &&
        !(useGitignore && isIgnored(stack, file, false));
      if (ok && !files.has(realpathSync(file))) files.set(realpathSync(file), { file, root });
    }
    if (depth >= maxDepth) return;

    const subdirs = [];
    for (const e of entries) {
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) {
        if (!opts.followSymlinks) continue;
        try {
          isDir = (await stat(join(dir, e.name))).isDirectory();
        } catch {
          continue;
        }
      }
      if (!isDir) continue;
      if (ignoreNames.some((re) => re.test(e.name))) continue;
      const abs = join(dir, e.name);
      if (excluded?.(relToRoot(abs))) continue;
      if (useGitignore && isIgnored(stack, abs, true)) continue;
      subdirs.push(abs);
    }
    await Promise.all(subdirs.map((d) => walk(d, root, depth + 1, stack)));
  };

  for (const root of roots) {
    if (!existsSync(root)) {
      warnings.push(`Directory not found: ${relFromCwd(cwd, root)}`);
      continue;
    }
    if ((await stat(root)).isFile()) {
      // Allow passing a package.json directly.
      files.set(realpathSync(root), { file: root, root: dirname(root) });
      continue;
    }
    await walk(root, root, 0, useGitignore ? ancestorIgnores(root) : []);
  }

  const projects: Project[] = [];
  const broken: BrokenFile[] = [];
  for (const { file, root } of [...files.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const rel = relFromCwd(cwd, file);
    let text: string;
    let json: Record<string, unknown>;
    try {
      text = await readFile(file, 'utf8');
      const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not a JSON object');
      json = parsed as Record<string, unknown>;
    } catch (e) {
      broken.push({ file, rel, error: (e as Error).message });
      warnings.push(`Skipping ${rel}: ${(e as Error).message}`);
      continue;
    }
    const dir = dirname(file);
    const project: Project = {
      file,
      dir,
      rel,
      relDir: relFromCwd(cwd, dir),
      root,
      name: typeof json.name === 'string' ? json.name : undefined,
      version: typeof json.version === 'string' ? json.version : undefined,
      private: json.private === true,
      lock: findLock(dir),
      text,
      json,
      deps: [],
    };
    let ws = workspaceGlobs(json);
    if (!ws && existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      ws = parsePnpmWorkspace(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'));
    }
    if (ws?.length) project.workspaces = ws;
    project.deps = extractDeps(project);
    projects.push(project);
  }

  linkWorkspaces(projects);
  return { roots, projects, broken, warnings };
}

/** Mark workspace members, inherit the root's lock file and flag internal dependencies. */
export function linkWorkspaces(projects: Project[]): void {
  const roots = projects.filter((p) => p.workspaces).sort((a, b) => b.dir.length - a.dir.length);
  for (const p of projects) {
    for (const r of roots) {
      if (r === p || !p.dir.startsWith(r.dir + (r.dir.endsWith('/') ? '' : '/'))) continue;
      const rel = toPosix(relative(r.dir, p.dir));
      const positives = r.workspaces!.filter((g) => !g.startsWith('!'));
      const negatives = r.workspaces!.filter((g) => g.startsWith('!')).map((g) => g.slice(1));
      const m = (g: string): boolean => globToRegExp(g.replace(/^\.\//, '').replace(/\/+$/, '')).test(rel);
      if (positives.some(m) && !negatives.some(m)) {
        p.workspaceRoot = r;
        break;
      }
    }
  }
  for (const p of projects) {
    let lock = p.lock;
    for (let w = p.workspaceRoot; !lock && w; w = w.workspaceRoot) lock = w.lock;
    if (!lock) {
      // Walk up the file system for a lock in a parent directory (e.g. unscanned workspace root).
      let d = dirname(p.dir);
      for (let i = 0; i < 8 && !lock; i++) {
        const l = findLock(d);
        if (l && (existsSync(join(d, 'pnpm-workspace.yaml')) || hasWorkspaces(d))) lock = l;
        const up = dirname(d);
        if (up === d) break;
        d = up;
      }
    }
    p.effectiveLock = lock;
  }
  // Internal deps: names of packages that belong to the same workspace.
  const topOf = (p: Project): Project => {
    let t = p;
    while (t.workspaceRoot) t = t.workspaceRoot;
    return t;
  };
  const namesByTop = new Map<Project, Set<string>>();
  for (const p of projects) {
    if (!p.name) continue;
    const top = topOf(p);
    if (!top.workspaces) continue;
    if (!namesByTop.has(top)) namesByTop.set(top, new Set());
    namesByTop.get(top)!.add(p.name);
  }
  for (const p of projects) {
    const names = namesByTop.get(topOf(p));
    for (const d of p.deps) {
      if (d.spec.kind === 'workspace' || names?.has(d.name)) d.internal = true;
    }
  }
}

function hasWorkspaces(dir: string): boolean {
  try {
    return Boolean(
      workspaceGlobs(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>),
    );
  } catch {
    return false;
  }
}
