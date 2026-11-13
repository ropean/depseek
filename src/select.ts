import { list } from './args.js';
import type { Config } from './config.js';
import { DEFAULT_DEP_KINDS, DEP_KINDS, type DepEntry, type DepKind, type Project } from './project.js';
import { nameMatcher, pathMatcher } from './util/glob.js';
import { LEVELS, type Level } from './versions.js';
import type { OptValues } from './args.js';

export interface Selection {
  kinds: Set<DepKind>;
  filter?: (name: string) => boolean;
  reject?: (name: string) => boolean;
  project?: (p: Project) => boolean;
  levels?: Set<Level>;
  /** name → reason, from config "ignore". */
  ignored: (name: string) => string | undefined;
}

const KIND_ALIASES: Record<string, DepKind> = {
  prod: 'prod',
  dependencies: 'prod',
  dev: 'dev',
  devDependencies: 'dev',
  peer: 'peer',
  peerDependencies: 'peer',
  optional: 'optional',
  optionalDependencies: 'optional',
  overrides: 'overrides',
  resolutions: 'overrides',
  packageManager: 'packageManager',
  pm: 'packageManager',
};

export function parseKinds(input: string[] | undefined): Set<DepKind> {
  if (!input?.length) return new Set(DEFAULT_DEP_KINDS);
  const out = new Set<DepKind>();
  for (const k of input) {
    if (k === 'all') DEP_KINDS.forEach((x) => out.add(x));
    else if (KIND_ALIASES[k]) out.add(KIND_ALIASES[k]);
    else throw new Error(`Unknown dependency type "${k}" (expected ${DEP_KINDS.join(', ')})`);
  }
  return out;
}

export function parseLevels(input: string[] | undefined): Set<Level> | undefined {
  if (!input?.length) return undefined;
  const out = new Set<Level>();
  for (const l of input) {
    const n = l === 'pre' ? 'prerelease' : l;
    if (!(LEVELS as readonly string[]).includes(n))
      throw new Error(`Unknown level "${l}" (expected ${LEVELS.join(', ')})`);
    out.add(n as Level);
  }
  return out;
}

export function projectMatcher(patterns: string[] | undefined): ((p: Project) => boolean) | undefined {
  if (!patterns?.length) return undefined;
  const byPath = pathMatcher(patterns);
  const byName = nameMatcher(patterns)!;
  return (p) => byPath(p.relDir) || byPath(p.rel) || (p.name !== undefined && byName(p.name));
}

/** ncu --no-root: leave workspace roots out. */
function withoutRoot(m: ((p: Project) => boolean) | undefined, noRoot: boolean): ((p: Project) => boolean) | undefined {
  if (!noRoot) return m;
  return (p) => !p.workspaces && (!m || m(p));
}

export function buildSelection(opts: OptValues, config: Config): Selection {
  const ignoreList = (config.ignore ?? []).map((i) => (typeof i === 'string' ? { name: i } : i));
  const ignoreMatchers = ignoreList.map((i) => ({ m: nameMatcher(i.name)!, reason: i.reason ?? 'ignored in config' }));
  const cfgList = (v: string[] | string | undefined): string[] | undefined => (v === undefined ? undefined : list(v));
  return {
    kinds: parseKinds(list(opts.dep) ?? cfgList(config.dep)),
    filter: nameMatcher(list(opts.filter) ?? cfgList(config.filter)),
    reject: nameMatcher(list(opts.reject) ?? cfgList(config.reject)),
    project: withoutRoot(projectMatcher(list(opts.project) ?? cfgList(config.project)), Boolean(opts.noRoot)),
    levels: parseLevels(list(opts.level) ?? cfgList(config.level)),
    ignored: (name) => ignoreMatchers.find((i) => i.m(name))?.reason,
  };
}

/** Entries that pass kind / name / project filters (internal workspace deps excluded). */
export function selectEntries(projects: Project[], sel: Selection, opts: { names?: Set<string> } = {}): DepEntry[] {
  const out: DepEntry[] = [];
  for (const p of projects) {
    if (sel.project && !sel.project(p)) continue;
    for (const d of p.deps) {
      if (d.internal) continue;
      if (!sel.kinds.has(d.kind)) continue;
      if (opts.names && !opts.names.has(d.name)) continue;
      if (sel.filter && !sel.filter(d.name)) continue;
      if (sel.reject?.(d.name)) continue;
      out.push(d);
    }
  }
  return out;
}
