import semver from 'semver';
import type { ConflictProjectGroup } from './config.js';
import { installedManifest, installedVersion } from './lock.js';
import type { DepEntry, Project } from './project.js';
import { nameMatcher, pathMatcher } from './util/glob.js';

export type Severity = 'high' | 'medium' | 'low' | 'hint';
export type ConflictType = 'major' | 'minor' | 'format' | 'section';

export interface Variant {
  raw: string;
  base?: string;
  entries: DepEntry[];
}

export interface Conflict {
  name: string;
  /** Project group (config conflicts.groups) the conflict belongs to. */
  group?: string;
  severity: Severity;
  type: ConflictType;
  /** Most used first. */
  variants: Variant[];
  /** Sections the dependency appears in, when they differ. */
  sections?: string[];
}

export interface PeerProblem {
  project: Project;
  /** Installed package declaring the peer dependency. */
  pkg: string;
  pkgVersion?: string;
  peer: string;
  range: string;
  installed: string;
}

export const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, hint: 3 };

/** "major line" of a version: 0.x versions are split by minor (0.3 vs 0.4 is breaking). */
export function majorKey(version: string): string {
  const v = semver.parse(version);
  if (!v) return version;
  return v.major === 0 ? `0.${v.minor}` : String(v.major);
}

export interface FindConflictsOptions {
  ignore?: string[];
  groups?: ConflictProjectGroup[];
}

export function projectGroup(p: Project, groups: ConflictProjectGroup[] | undefined): string | undefined {
  for (const g of groups ?? []) {
    const byPath = pathMatcher(g.projects);
    const byName = nameMatcher(g.projects)!;
    if (byPath(p.relDir) || (p.name && byName(p.name))) return g.name ?? g.projects.join(',');
  }
  return undefined;
}

export function findConflicts(entries: DepEntry[], opts: FindConflictsOptions = {}): Conflict[] {
  const ignore = nameMatcher(opts.ignore ?? []);
  const buckets = new Map<string, DepEntry[]>();
  for (const e of entries) {
    if (e.internal || e.kind === 'peer') continue;
    if (e.spec.kind !== 'range') continue;
    if (ignore?.(e.name)) continue;
    const group = projectGroup(e.project, opts.groups) ?? '';
    const key = `${group}\0${e.name}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(e);
  }
  const out: Conflict[] = [];
  for (const [key, es] of buckets) {
    const [group, name] = key.split('\0') as [string, string];
    const byRaw = new Map<string, Variant>();
    for (const e of es) {
      const v = byRaw.get(e.raw) ?? { raw: e.raw, base: e.spec.base, entries: [] };
      v.entries.push(e);
      byRaw.set(e.raw, v);
    }
    const variants = [...byRaw.values()].sort(
      (a, b) => b.entries.length - a.entries.length || (a.base && b.base ? semver.rcompare(a.base, b.base) : 0),
    );
    const sections = [
      ...new Set(es.filter((e) => e.kind !== 'overrides' && e.kind !== 'packageManager').map((e) => e.section)),
    ];
    let severity: Severity;
    let type: ConflictType;
    if (variants.length > 1) {
      const majors = new Set(variants.map((v) => (v.base ? majorKey(v.base) : v.raw)));
      const bases = new Set(variants.map((v) => v.base ?? v.raw));
      if (majors.size > 1) [severity, type] = ['high', 'major'];
      else if (bases.size > 1) [severity, type] = ['medium', 'minor'];
      else [severity, type] = ['low', 'format'];
    } else if (sections.length > 1 && new Set(es.map((e) => e.project)).size > 1) {
      [severity, type] = ['hint', 'section'];
    } else continue;
    out.push({
      name,
      group: group || undefined,
      severity,
      type,
      variants,
      sections: sections.length > 1 ? sections : undefined,
    });
  }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.name.localeCompare(b.name));
}

/** Installed packages whose peerDependencies aren't satisfied by what's installed next to them. */
export function findPeerProblems(projects: Project[], entries: DepEntry[]): PeerProblem[] {
  const out: PeerProblem[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'peer' || e.kind === 'overrides' || e.kind === 'packageManager' || e.internal) continue;
    const m = installedManifest(e.project, e.spec.alias ? e.path[e.path.length - 1]! : e.name);
    if (!m?.peerDependencies) continue;
    for (const [peer, range] of Object.entries(m.peerDependencies)) {
      if (m.peerDependenciesMeta?.[peer]?.optional || !semver.validRange(range)) continue;
      const installed = installedVersion(e.project, peer);
      if (!installed || semver.satisfies(installed, range, { includePrerelease: true })) continue;
      const key = `${e.project.file}\0${e.name}\0${peer}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ project: e.project, pkg: e.name, pkgVersion: m.version, peer, range, installed });
    }
  }
  void projects;
  return out;
}

export type AlignStrategy = 'highest' | 'lowest' | 'most-used' | 'latest';

/** Version to align a set of variants to (latest is resolved by the caller). */
export function alignTarget(variants: Variant[], strategy: Exclude<AlignStrategy, 'latest'>): string | undefined {
  const withBase = variants.filter((v) => v.base);
  if (!withBase.length) return undefined;
  if (strategy === 'most-used') {
    return [...withBase].sort((a, b) => b.entries.length - a.entries.length || semver.rcompare(a.base!, b.base!))[0]!
      .base;
  }
  const sorted = semver.sort(withBase.map((v) => v.base!));
  return strategy === 'lowest' ? sorted[0] : sorted[sorted.length - 1];
}
