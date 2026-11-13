import semver from 'semver';
import type { Config } from './config.js';
import { resolvedInstalled } from './lock.js';
import type { DepEntry, DepKind, Project } from './project.js';
import { RegistryError, type PackageMeta, type RegistryClient } from './registry.js';
import type { Selection } from './select.js';
import { formatSpec, UNCHECKABLE, type Format } from './spec.js';
import { nameMatcher } from './util/glob.js';
import { candidates, diffLevel, pickTarget, resolveRange, type Level } from './versions.js';

export type WarningType = 'peer' | 'engines' | 'deprecated' | 'license' | 'vulnerable' | 'group' | 'types';

export interface Warning {
  type: WarningType;
  message: string;
}

export interface Update {
  entry: DepEntry;
  name: string;
  /** Lowest version of the current range. */
  current: string;
  target: string;
  /** New spec string (before packageManager encoding). */
  newRaw: string;
  level: Level;
  zero: boolean;
  /** Publish time of the target version. */
  published?: string;
  warnings: Warning[];
  /** Explicitly requested via `up pkg@version`. */
  explicit?: boolean;
  downgrade?: boolean;
}

export interface Skipped {
  entry: DepEntry;
  reason: string;
  /** git / url / invalid specs: listed as "cannot check". */
  uncheckable?: boolean;
}

export interface DeprecatedUse {
  entry: DepEntry;
  version: string;
  message: string;
}

export interface Analysis {
  entries: DepEntry[];
  updates: Update[];
  skipped: Skipped[];
  ignored: { entry: DepEntry; reason: string }[];
  errors: Map<string, string>;
  metas: Map<string, PackageMeta>;
  deprecated: DeprecatedUse[];
  /** Updates removed by --level. */
  filteredByLevel: number;
}

export const BUILTIN_GROUPS: readonly string[][] = [
  ['react', 'react-dom', 'react-test-renderer', 'react-is'],
  ['vue', '@vue/compiler-sfc', '@vue/compiler-dom', '@vue/runtime-dom', '@vue/server-renderer', '@vue/shared'],
  [
    '@angular/core',
    '@angular/common',
    '@angular/compiler',
    '@angular/compiler-cli',
    '@angular/forms',
    '@angular/router',
    '@angular/animations',
    '@angular/platform-browser',
    '@angular/platform-browser-dynamic',
    '@angular/platform-server',
  ],
  ['@babel/core', '@babel/preset-env'],
  ['vitest', '@vitest/ui', '@vitest/coverage-v8', '@vitest/coverage-istanbul', '@vitest/browser'],
  ['@typescript-eslint/parser', '@typescript-eslint/eslint-plugin', 'typescript-eslint'],
];

export interface AnalyzeOptions {
  client: RegistryClient;
  selection: Selection;
  /** Target strategy (latest, minor, patch, semver, greatest, newest, @tag). */
  target?: string;
  /** CLI --format (overrides config). */
  format?: Format;
  formatConfig?: Config['format'];
  cooldown?: number;
  pinWildcards?: boolean;
  pins?: Config['pin'];
  ignoreVersions?: Config['ignoreVersions'];
  groups?: Config['groups'];
  builtinGroups?: boolean;
  runtime?: Config['runtime'];
  licenseCheck?: boolean;
  /** `up react@19 vite` — name → range ('' = use the target strategy). */
  explicit?: Map<string, string>;
  onProgress?: (done: number, total: number) => void;
  now?: number;
}

export function resolveFormat(
  entry: DepEntry,
  cli: Format | undefined,
  cfg: Config['format'],
  target?: string,
): Format {
  if (target === 'semver') return 'preserve';
  if (cli) return cli;
  if (typeof cfg === 'string') return cfg;
  if (cfg) {
    const byKind = cfg[entry.kind as DepKind];
    if (byKind) return byKind;
    const bySection = cfg[entry.section];
    if (bySection) return bySection;
    if (cfg.default) return cfg.default;
  }
  return 'exact';
}

function splitNameSpec(s: string): [string, string] {
  const at = s.indexOf('@', s.startsWith('@') ? 1 : 0);
  return at === -1 ? [s, ''] : [s.slice(0, at), s.slice(at + 1)];
}

/** Registry name for an entry (yarn berry lives at @yarnpkg/cli-dist). */
export function registryName(entry: DepEntry): string {
  if (
    entry.kind === 'packageManager' &&
    entry.name === 'yarn' &&
    entry.spec.base &&
    semver.major(entry.spec.base) >= 2
  ) {
    return '@yarnpkg/cli-dist';
  }
  return entry.name;
}

/** The version that is (or would be) installed for an entry. */
export function currentResolved(entry: DepEntry, meta: PackageMeta | undefined): string | undefined {
  const installed = resolvedInstalled(entry);
  if (installed && (!entry.spec.range || semver.satisfies(installed, entry.spec.range, { includePrerelease: true })))
    return installed;
  if (meta && entry.spec.range) {
    const v = semver.maxSatisfying(Object.keys(meta.versions), entry.spec.range);
    if (v) return v;
  }
  return entry.spec.base;
}

function typesBase(name: string): string | undefined {
  if (!name.startsWith('@types/')) return undefined;
  const rest = name.slice(7);
  return rest.includes('__') ? `@${rest.replace('__', '/')}` : rest;
}

export async function analyze(projects: Project[], entries: DepEntry[], opts: AnalyzeOptions): Promise<Analysis> {
  const sel = opts.selection;
  const strategy = opts.target ?? 'latest';
  const skipped: Skipped[] = [];
  const ignored: { entry: DepEntry; reason: string }[] = [];
  const checkable: DepEntry[] = [];

  for (const e of entries) {
    if (opts.explicit && !opts.explicit.has(e.name)) continue;
    const reason = sel.ignored(e.name);
    if (reason && !opts.explicit) {
      ignored.push({ entry: e, reason });
      continue;
    }
    const k = e.spec.kind;
    if (UNCHECKABLE.has(k)) {
      const uncheckable = k === 'git' || k === 'url' || k === 'invalid';
      skipped.push({ entry: e, reason: uncheckable ? `cannot check (${k})` : `skipped (${k})`, uncheckable });
      continue;
    }
    if ((k === 'wildcard' && !opts.pinWildcards && !opts.explicit?.get(e.name)) || k === 'tag') {
      skipped.push({ entry: e, reason: k === 'tag' ? `dist-tag "${e.raw}"` : 'wildcard (use --pin-wildcards)' });
      continue;
    }
    checkable.push(e);
  }

  const metas = new Map<string, PackageMeta>();
  const errors = new Map<string, string>();
  const fetched = await opts.client.getMany(
    checkable.map((e) => registryName(e)),
    opts.onProgress,
  );
  for (const [name, m] of fetched) {
    if (m instanceof RegistryError) errors.set(name, m.message);
    else metas.set(name, m);
  }

  // Config: pins and ignored versions per package.
  const pinFor = (name: string): string | undefined => {
    const p = opts.pins?.[name];
    return typeof p === 'string' ? p : p?.range;
  };
  const ignoreVersionRules = (opts.ignoreVersions ?? []).map((iv) => {
    const [n, range] = splitNameSpec(typeof iv === 'string' ? iv : iv.spec);
    return { match: nameMatcher(n)!, range };
  });
  const excludeFor = (name: string): ((v: string) => boolean) | undefined => {
    const rules = ignoreVersionRules.filter((r) => r.match(name));
    if (!rules.length) return undefined;
    return (v) => rules.some((r) => !r.range || semver.satisfies(v, r.range, { includePrerelease: true }));
  };
  const candOpts = (name: string) => ({
    cooldownDays: opts.cooldown,
    exclude: excludeFor(name),
    pin: pinFor(name),
    now: opts.now,
  });

  const updates: Update[] = [];
  const makeUpdate = (
    e: DepEntry,
    meta: PackageMeta,
    target: string,
    extra: Partial<Update> = {},
  ): Update | undefined => {
    const current = e.spec.base ?? '0.0.0';
    const fmt = resolveFormat(e, opts.format, opts.formatConfig, strategy);
    const newRaw = formatSpec(e.spec, target, fmt);
    if (newRaw === e.raw) return undefined;
    const downgrade = semver.valid(current) ? semver.lt(target, current) : false;
    const { level, zero } =
      e.spec.kind === 'wildcard' ? { level: 'major' as Level, zero: false } : diffLevel(current, target);
    return {
      entry: e,
      name: e.name,
      current,
      target,
      newRaw,
      level,
      zero,
      published: meta.time[target],
      warnings: [],
      downgrade,
      ...extra,
    };
  };

  for (const e of checkable) {
    const meta = metas.get(registryName(e));
    if (!meta) continue;
    const explicitRange = opts.explicit?.get(e.name);
    if (explicitRange) {
      const v = resolveRange(meta, explicitRange);
      if (!v) {
        errors.set(e.name, `no version matching "${explicitRange}" in registry`);
        continue;
      }
      const u = makeUpdate(e, meta, v, { explicit: true });
      if (u) updates.push(u);
      continue;
    }
    let target: string | undefined;
    if (e.spec.kind === 'wildcard') {
      target = pickTarget(meta, undefined, strategy === 'semver' ? 'latest' : strategy, undefined, candOpts(e.name));
    } else {
      target = pickTarget(meta, e.spec.base, strategy, e.spec.range, candOpts(e.name));
    }
    if (!target) continue;
    const u = makeUpdate(e, meta, target);
    if (u) updates.push(u);
  }

  applyGroups(updates, checkable, metas, opts, makeUpdate);
  applyTypesFollow(projects, updates, metas, opts, candOpts);

  // Level filter.
  let filteredByLevel = 0;
  let final = updates;
  if (sel.levels) {
    final = updates.filter((u) => u.explicit || sel.levels!.has(u.level));
    filteredByLevel = updates.length - final.length;
  }

  // Deprecated current versions.
  const deprecated: DeprecatedUse[] = [];
  for (const e of checkable) {
    const meta = metas.get(registryName(e));
    if (!meta) continue;
    const v = currentResolved(e, meta);
    const msg = v ? meta.versions[v]?.deprecated : undefined;
    if (v && msg) deprecated.push({ entry: e, version: v, message: msg });
  }

  runChecks(projects, final, metas, opts);
  return { entries, updates: final, skipped, ignored, errors, metas, deprecated, filteredByLevel };
}

/** Keep @types/* on the same major (and minor where possible) as the package they describe. */
function applyTypesFollow(
  projects: Project[],
  updates: Update[],
  metas: Map<string, PackageMeta>,
  opts: AnalyzeOptions,
  candOpts: (name: string) => Parameters<typeof candidates>[1],
): void {
  void projects;
  for (let i = updates.length - 1; i >= 0; i--) {
    const u = updates[i]!;
    const baseName = typesBase(u.name);
    if (!baseName || u.explicit) continue;
    const p = u.entry.project;
    let baseVersion: string | undefined;
    if (baseName === 'node') {
      const engines = (p.json.engines as Record<string, string> | undefined)?.node;
      baseVersion =
        opts.runtime?.node ??
        (engines && semver.validRange(engines) ? semver.minVersion(engines)?.version : undefined) ??
        u.current; // unknown runtime → stay on the current major
    } else {
      const baseEntry =
        p.deps.find((d) => d.name === baseName && d.kind !== 'peer') ?? p.deps.find((d) => d.name === baseName);
      if (!baseEntry) continue;
      const baseUpdate = updates.find((x) => x.entry === baseEntry);
      baseVersion = baseUpdate?.target ?? baseEntry.spec.base;
    }
    const bv = baseVersion ? semver.coerce(baseVersion) : null;
    if (!bv) continue;
    if (semver.major(u.target) === bv.major && (semver.major(u.target) !== 0 || semver.minor(u.target) <= bv.minor))
      continue;
    const meta = metas.get(u.name)!;
    const pool = candidates(meta, candOpts(u.name)).filter(
      (v) => !semver.prerelease(v) && semver.major(v) === bv.major,
    );
    const sameMinor = pool.filter((v) => semver.minor(v) === bv.minor);
    const best = semver.rsort(sameMinor.length ? sameMinor : pool.filter((v) => semver.minor(v) <= bv.minor))[0];
    if (!best || !semver.gt(best, u.current)) {
      updates.splice(i, 1);
      continue;
    }
    const lvl = diffLevel(u.current, best);
    const fmt = resolveFormat(u.entry, opts.format, opts.formatConfig, opts.target);
    updates[i] = {
      ...u,
      target: best,
      newRaw: formatSpec(u.entry.spec, best, fmt),
      level: lvl.level,
      zero: lvl.zero,
      published: meta.time[best],
      warnings: [...u.warnings, { type: 'types', message: `held at ${bv.major}.x to match ${baseName}@${bv.version}` }],
    };
    if (updates[i]!.newRaw === u.entry.raw) updates.splice(i, 1);
  }
}

/** Packages in a group move to one common version inside each project. */
function applyGroups(
  updates: Update[],
  entries: DepEntry[],
  metas: Map<string, PackageMeta>,
  opts: AnalyzeOptions,
  makeUpdate: (e: DepEntry, meta: PackageMeta, target: string, extra?: Partial<Update>) => Update | undefined,
): void {
  const groups: string[][] = [
    ...(opts.builtinGroups === false ? [] : BUILTIN_GROUPS),
    ...(opts.groups ?? []).map((g) => (Array.isArray(g) ? g : g.packages)),
  ];
  if (!groups.length) return;
  const byProject = new Map<Project, DepEntry[]>();
  for (const e of entries) {
    if (!byProject.has(e.project)) byProject.set(e.project, []);
    byProject.get(e.project)!.push(e);
  }
  for (const group of groups) {
    const match = nameMatcher(group)!;
    for (const [, projEntries] of byProject) {
      const members = projEntries.filter((e) => match(e.name) && e.kind !== 'peer' && e.spec.kind === 'range');
      if (members.length < 2) continue;
      const memberUpdates = members.map((m) => updates.find((u) => u.entry === m));
      const present = memberUpdates.filter((u): u is Update => Boolean(u));
      const explicitTarget = present.find((u) => u.explicit && !u.downgrade)?.target;
      const targets = present.filter((u) => !u.explicit).map((u) => u.target);
      if (!targets.length) continue;
      // An explicitly requested version (`up react@19.0.0`) wins; otherwise the lowest common target.
      const common = explicitTarget ?? semver.sort([...targets])[0]!;
      if (members.some((m) => m.spec.base && semver.gt(m.spec.base, common))) continue;
      const label = `the ${group[0]} group`;
      members.forEach((m, i) => {
        const meta = metas.get(m.name);
        if (!meta) return;
        const existing = memberUpdates[i];
        if (existing?.explicit) return;
        if (!meta.versions[common]) {
          existing?.warnings.push({ type: 'group', message: `no ${common} release to align with ${label}` });
          return;
        }
        const idx = existing ? updates.indexOf(existing) : -1;
        const u = makeUpdate(m, meta, common);
        if (!u) {
          if (idx >= 0) updates.splice(idx, 1);
          return;
        }
        if (existing && existing.target !== common)
          u.warnings.push({ type: 'group', message: `aligned with ${label}` });
        if (idx >= 0) updates[idx] = u;
        else if (m.spec.base && semver.lt(m.spec.base, common)) {
          u.warnings.push({ type: 'group', message: `upgraded together with ${label}` });
          updates.push(u);
        }
      });
    }
  }
}

function runtimeNode(opts: AnalyzeOptions): string {
  return opts.runtime?.node ?? process.versions.node;
}

/** Peer-dependency preflight, engines, license changes and deprecated targets. */
function runChecks(
  projects: Project[],
  updates: Update[],
  metas: Map<string, PackageMeta>,
  opts: AnalyzeOptions,
): void {
  const node = runtimeNode(opts);
  const bun = opts.runtime?.bun ?? process.versions.bun;
  const byProject = new Map<Project, Update[]>();
  for (const u of updates) {
    if (!byProject.has(u.entry.project)) byProject.set(u.entry.project, []);
    byProject.get(u.entry.project)!.push(u);
  }

  for (const u of updates) {
    const meta = metas.get(registryName(u.entry));
    const tm = meta?.versions[u.target];
    if (!meta || !tm) continue;
    if (tm.deprecated) u.warnings.push({ type: 'deprecated', message: `${u.target} is deprecated: ${tm.deprecated}` });
    const eng = tm.engines;
    if (eng?.node && semver.validRange(eng.node) && !semver.satisfies(node, eng.node, { includePrerelease: true })) {
      u.warnings.push({ type: 'engines', message: `requires node ${eng.node} (runtime ${node})` });
    }
    if (bun && eng?.bun && semver.validRange(eng.bun) && !semver.satisfies(bun, eng.bun, { includePrerelease: true })) {
      u.warnings.push({ type: 'engines', message: `requires bun ${eng.bun} (runtime ${bun})` });
    }
    if (opts.licenseCheck !== false) {
      const cur = resolvedInstalled(u.entry) ?? u.entry.spec.base;
      const before = cur ? meta.versions[cur]?.license : undefined;
      if (before && tm.license && before !== tm.license) {
        u.warnings.push({ type: 'license', message: `license changes ${before} → ${tm.license}` });
      }
    }
  }

  for (const [project, ups] of byProject) {
    void projects;
    // Versions after the upgrade, for every dependency of the project we know about.
    const after = new Map<string, string>();
    for (const d of project.deps) {
      if (d.kind === 'peer' || d.kind === 'overrides' || d.kind === 'packageManager') continue;
      const v = currentResolved(d, metas.get(d.name));
      if (v) after.set(d.name, v);
    }
    for (const u of ups) if (u.entry.kind !== 'peer') after.set(u.name, u.target);

    for (const u of ups) {
      if (u.entry.kind === 'peer' || u.entry.kind === 'overrides') continue;
      // 1) The new version's own peer requirements.
      const peers = metas.get(u.name)?.versions[u.target]?.peerDependencies ?? {};
      const peerMeta = metas.get(u.name)?.versions[u.target]?.peerDependenciesMeta ?? {};
      for (const [peer, range] of Object.entries(peers)) {
        const have = after.get(peer);
        if (!have || peerMeta[peer]?.optional || !semver.validRange(range)) continue;
        if (!semver.satisfies(have, range, { includePrerelease: true })) {
          u.warnings.push({
            type: 'peer',
            message: `${u.name}@${u.target} wants ${peer}@${range}, project has ${have}`,
          });
        }
      }
      // 2) Other packages in the project that declare this package as a peer.
      for (const d of project.deps) {
        if (d === u.entry || d.kind === 'peer') continue;
        const v = after.get(d.name);
        const dm = v ? metas.get(d.name)?.versions[v] : undefined;
        const range = dm?.peerDependencies?.[u.name];
        if (!range || dm?.peerDependenciesMeta?.[u.name]?.optional || !semver.validRange(range)) continue;
        if (!semver.satisfies(u.target, range, { includePrerelease: true })) {
          u.warnings.push({ type: 'peer', message: `${d.name}@${v} wants ${u.name}@${range}` });
        }
      }
    }
  }
}
