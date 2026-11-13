import { parseSpec, type ParsedSpec } from './spec.js';

export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn';

export interface LockInfo {
  pm: PackageManager;
  /** Absolute path of the lock file. */
  file: string;
  /** File name, e.g. "bun.lock". */
  name: string;
}

export const LOCK_FILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];

export type DepKind = 'prod' | 'dev' | 'peer' | 'optional' | 'overrides' | 'packageManager';
export const DEP_KINDS: readonly DepKind[] = ['prod', 'dev', 'peer', 'optional', 'overrides', 'packageManager'];
export const DEFAULT_DEP_KINDS: readonly DepKind[] = ['prod', 'dev', 'optional'];

export interface Project {
  /** Absolute path to package.json. */
  file: string;
  /** Absolute directory. */
  dir: string;
  /** package.json path relative to the current directory (posix). */
  rel: string;
  /** Directory relative to the current directory (posix, "." for cwd). */
  relDir: string;
  /** Absolute scan root this project was found under. */
  root: string;
  name?: string;
  version?: string;
  private?: boolean;
  /** Lock file in this directory. */
  lock?: LockInfo;
  /** Lock file that governs installs (own, or the workspace root's). */
  effectiveLock?: LockInfo;
  /** Workspace globs if this is a workspace root. */
  workspaces?: string[];
  /** Workspace root project, if this package is a workspace member. */
  workspaceRoot?: Project;
  text: string;
  json: Record<string, unknown>;
  deps: DepEntry[];
}

export interface DepEntry {
  project: Project;
  kind: DepKind;
  /** Display section name, e.g. "devDependencies" or "pnpm.overrides". */
  section: string;
  /** JSON path of the string value. */
  path: string[];
  /** Real package name (alias target excluded; see spec.alias). */
  name: string;
  /** The version string as written. */
  raw: string;
  spec: ParsedSpec;
  /** Points to a package inside the same workspace — never updated. */
  internal?: boolean;
  /** Turn a new version spec back into the stored string (packageManager uses "pnpm@x"). */
  encode?: (spec: string) => string;
}

const SECTIONS: [string, DepKind][] = [
  ['dependencies', 'prod'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
];

/** Package name targeted by an overrides/resolutions key such as `**\/foo`, `a>b`, `foo@^1`. */
export function overrideKeyName(key: string): string {
  let k = key.split('>').pop()!;
  k = k
    .split('/**/')
    .pop()!
    .replace(/^\*\*\//, '');
  // a/b (yarn nested resolution) where a isn't a scope
  const segs = k.split('/');
  if (segs.length > 1 && !k.startsWith('@')) k = segs[segs.length - 1]!;
  if (k.startsWith('@') && segs.length > 2) k = segs.slice(-2).join('/');
  const at = k.indexOf('@', k.startsWith('@') ? 1 : 0);
  return at === -1 ? k : k.slice(0, at);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function extractDeps(project: Project): DepEntry[] {
  const json = project.json;
  const out: DepEntry[] = [];
  const push = (kind: DepKind, section: string, path: string[], name: string, raw: string): void => {
    const spec = parseSpec(raw);
    out.push({ project, kind, section, path, name: spec.alias ?? name, raw, spec });
  };
  for (const [section, kind] of SECTIONS) {
    const obj = json[section];
    if (!isObj(obj)) continue;
    for (const [name, raw] of Object.entries(obj)) {
      if (typeof raw === 'string') push(kind, section, [section, name], name, raw);
    }
  }
  const overrideSections: [string[], string][] = [
    [['overrides'], 'overrides'],
    [['resolutions'], 'resolutions'],
    [['pnpm', 'overrides'], 'pnpm.overrides'],
  ];
  for (const [path, section] of overrideSections) {
    let obj: unknown = json;
    for (const p of path) obj = isObj(obj) ? obj[p] : undefined;
    if (!isObj(obj)) continue;
    for (const [key, val] of Object.entries(obj)) {
      if (typeof val === 'string') push('overrides', section, [...path, key], overrideKeyName(key), val);
      else if (isObj(val) && typeof val['.'] === 'string') {
        push('overrides', section, [...path, key, '.'], overrideKeyName(key), val['.']);
      }
    }
  }
  const pm = json.packageManager;
  if (typeof pm === 'string') {
    const m = /^(@?[^@]+)@([^+]+)(\+.*)?$/.exec(pm);
    if (m && !m[3]) {
      const spec = parseSpec(m[2]!);
      out.push({
        project,
        kind: 'packageManager',
        section: 'packageManager',
        path: ['packageManager'],
        name: m[1]!,
        raw: m[2]!,
        spec,
        encode: (v) => `${m[1]}@${v}`,
      });
    }
  }
  return out;
}

export function workspaceGlobs(json: Record<string, unknown>): string[] | undefined {
  const ws = json.workspaces;
  if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === 'string');
  if (isObj(ws) && Array.isArray(ws.packages)) return ws.packages.filter((x): x is string => typeof x === 'string');
  return undefined;
}

/** Parse the `packages:` list of a pnpm-workspace.yaml without a YAML dependency. */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      const inline = /\[(.*)\]/.exec(line);
      if (inline) {
        out.push(
          ...inline[1]!
            .split(',')
            .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean),
        );
        inPackages = false;
      }
      continue;
    }
    if (inPackages) {
      const m = /^\s+-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line);
      if (m) out.push(m[1]!);
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  return out;
}
