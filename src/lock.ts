import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { DepEntry, Project } from './project.js';
import { toPosix } from './util/text.js';

const cache = new Map<string, unknown>();

function readCached<T>(file: string, parse: (text: string) => T): T | undefined {
  if (cache.has(file)) return cache.get(file) as T | undefined;
  let v: T | undefined;
  try {
    v = parse(readFileSync(file, 'utf8'));
  } catch {
    v = undefined;
  }
  cache.set(file, v);
  return v;
}

export function clearLockCache(): void {
  cache.clear();
}

/** Version installed in node_modules (searching up to the workspace root). */
export function installedVersion(project: Project, name: string): string | undefined {
  return installedManifest(project, name)?.version;
}

function jsonc(text: string): unknown {
  const stripped = text.replace(
    /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (m, s: string | undefined) => s ?? '',
  );
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'));
}

function fromPackageLock(lockFile: string, rel: string, name: string): string | undefined {
  const data = readCached(
    lockFile,
    (t) =>
      JSON.parse(t) as {
        packages?: Record<string, { version?: string }>;
        dependencies?: Record<string, { version?: string }>;
      },
  );
  if (!data) return undefined;
  const pk = data.packages;
  if (pk) {
    const nested = rel && rel !== '.' ? pk[`${rel}/node_modules/${name}`]?.version : undefined;
    return nested ?? pk[`node_modules/${name}`]?.version;
  }
  return data.dependencies?.[name]?.version;
}

function fromBunLock(lockFile: string, rel: string, name: string): string | undefined {
  const data = readCached(lockFile, (t) => jsonc(t) as { packages?: Record<string, unknown[]> });
  const pk = data?.packages;
  if (!pk) return undefined;
  // Workspace-specific resolutions are keyed "<workspace name>/<dep>"; fall back to the hoisted one.
  void rel;
  const entry = pk[name];
  if (!Array.isArray(entry) || typeof entry[0] !== 'string') return undefined;
  const id = entry[0];
  const v = id.slice(id.lastIndexOf('@') + 1);
  return /^\d/.test(v) ? v : undefined;
}

function fromPnpmLock(lockFile: string, rel: string, name: string): string | undefined {
  const lines = readCached(lockFile, (t) => t.split(/\r?\n/));
  if (!lines) return undefined;
  const importer = rel && rel !== '' ? rel : '.';
  let inImporters = false;
  let inThis = false;
  let inDep = false;
  for (const line of lines) {
    if (/^importers:\s*$/.test(line)) {
      inImporters = true;
      continue;
    }
    if (inImporters && /^\S/.test(line)) break;
    if (!inImporters) continue;
    const imp = /^ {2}(\S.*?):\s*$/.exec(line);
    if (imp) {
      inThis = imp[1]!.replace(/^['"]|['"]$/g, '') === importer;
      inDep = false;
      continue;
    }
    if (!inThis) continue;
    const dep = /^ {6}(\S.*?):\s*$/.exec(line);
    if (dep) {
      inDep = dep[1]!.replace(/^['"]|['"]$/g, '') === name;
      continue;
    }
    if (inDep) {
      const v = /^ {8}version:\s*['"]?([^'"(\s]+)/.exec(line);
      if (v) return /^\d/.test(v[1]!) ? v[1] : undefined;
    }
  }
  return undefined;
}

function fromYarnLock(lockFile: string, name: string, raw: string): string | undefined {
  const text = readCached(lockFile, (t) => t);
  if (!text) return undefined;
  const blocks = text.split(/\n(?=\S)/);
  for (const b of blocks) {
    const header = b.split('\n')[0]!;
    const keys = header
      .replace(/:$/, '')
      .split(/,\s*/)
      .map((k) => k.trim().replace(/^"|"$/g, ''));
    if (!keys.some((k) => k === `${name}@${raw}` || k === `${name}@npm:${raw}`)) continue;
    const v = /\n\s+version:?\s+"?([^"\s]+)"?/.exec(b);
    if (v) return v[1];
  }
  return undefined;
}

/** Version recorded in the lock file that governs this project. */
export function lockedVersion(entry: DepEntry): string | undefined {
  const p = entry.project;
  const lock = p.effectiveLock;
  if (!lock) return undefined;
  const rel = toPosix(relative(dirname(lock.file), p.dir));
  const name = entry.spec.alias ? entry.path[entry.path.length - 1]! : entry.name;
  switch (lock.name) {
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return fromPackageLock(lock.file, rel, name);
    case 'bun.lock':
      return fromBunLock(lock.file, rel, name);
    case 'pnpm-lock.yaml':
      return fromPnpmLock(lock.file, rel || '.', name);
    case 'yarn.lock':
      return fromYarnLock(lock.file, name, entry.raw);
    default:
      return undefined;
  }
}

/** Best knowledge of the actually-installed version: node_modules, then lock file. */
export function resolvedInstalled(entry: DepEntry): string | undefined {
  const name = entry.spec.alias ? entry.path[entry.path.length - 1]! : entry.name;
  return installedVersion(entry.project, name) ?? lockedVersion(entry);
}

/** package.json of an installed dependency (node_modules lookup only). */
export function installedManifest(
  project: Project,
  name: string,
):
  | {
      version?: string;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    }
  | undefined {
  let dir = project.dir;
  const stop = project.effectiveLock ? dirname(project.effectiveLock.file) : project.dir;
  for (let i = 0; i < 10; i++) {
    const file = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(file))
      return readCached(file, (t) => JSON.parse(t) as { version?: string; peerDependencies?: Record<string, string> });
    if (dir === stop) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}
