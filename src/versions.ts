import semver from 'semver';
import type { PackageMeta } from './registry.js';

export type Level = 'major' | 'minor' | 'patch' | 'prerelease';
export const LEVELS: readonly Level[] = ['major', 'minor', 'patch', 'prerelease'];

export interface LevelInfo {
  level: Level;
  /** 0.x minor / 0.0.x patch bump — treated as breaking (level "major"). */
  zero: boolean;
}

export function diffLevel(from: string, to: string): LevelInfo {
  const a = semver.parse(from);
  const b = semver.parse(to);
  if (!a || !b) return { level: 'major', zero: false };
  if (b.prerelease.length) return { level: 'prerelease', zero: false };
  if (a.major !== b.major) return { level: 'major', zero: false };
  if (a.minor !== b.minor) return a.major === 0 ? { level: 'major', zero: true } : { level: 'minor', zero: false };
  if (a.patch !== b.patch)
    return a.major === 0 && a.minor === 0 ? { level: 'major', zero: true } : { level: 'patch', zero: false };
  // Same x.y.z: leaving a prerelease for the release.
  return { level: 'patch', zero: false };
}

export type TargetStrategy = 'latest' | 'minor' | 'patch' | 'semver' | 'greatest' | 'newest' | `@${string}`;
export const TARGETS: readonly string[] = ['latest', 'minor', 'patch', 'semver', 'greatest', 'newest'];

export interface CandidateOptions {
  /** Ignore versions published less than this many days ago. */
  cooldownDays?: number;
  now?: number;
  /** Return true to exclude a version (ignoreVersions from config). */
  exclude?: (version: string) => boolean;
  /** Only allow versions inside this range (config "pin"). */
  pin?: string;
  /** Allow deprecated versions as targets. */
  allowDeprecated?: boolean;
  /** Extra predicate (ncu --peer / --enginesNode). */
  accept?: (version: string) => boolean;
  /** Prereleases count for latest / minor / patch (ncu --pre). */
  pre?: boolean;
}

export function candidates(meta: PackageMeta, opts: CandidateOptions = {}): string[] {
  const now = opts.now ?? Date.now();
  const cutoff = opts.cooldownDays ? now - opts.cooldownDays * 86_400_000 : undefined;
  return Object.keys(meta.versions).filter((v) => {
    if (!semver.valid(v)) return false;
    if (!opts.allowDeprecated && meta.versions[v]!.deprecated) return false;
    if (opts.exclude?.(v)) return false;
    if (opts.pin && !semver.satisfies(v, opts.pin, { includePrerelease: true })) return false;
    if (opts.accept && !opts.accept(v)) return false;
    if (cutoff !== undefined) {
      const t = Date.parse(meta.time[v] ?? '');
      if (!Number.isNaN(t) && t > cutoff) return false;
    }
    return true;
  });
}

const maxOf = (vs: string[]): string | undefined => (vs.length ? semver.rsort([...vs])[0] : undefined);
const stableOnly = (vs: string[]): string[] => vs.filter((v) => !semver.prerelease(v));

/**
 * Pick the version to upgrade to. `current` is the lowest version allowed by the current range;
 * `range` is the current range (used by the "semver" strategy).
 * Returns undefined when there is nothing newer.
 */
export function pickTarget(
  meta: PackageMeta,
  current: string | undefined,
  strategy: string,
  range: string | undefined,
  opts: CandidateOptions = {},
): string | undefined {
  const all = candidates(meta, opts);
  const cur = current ? semver.parse(current) : null;
  const stable = opts.pre ? (vs: string[]) => vs : stableOnly;
  if (opts.pre && strategy === 'latest') strategy = 'greatest';
  let target: string | undefined;

  if (strategy.startsWith('@')) {
    const t = meta.distTags[strategy.slice(1)];
    target = t && all.includes(t) ? t : undefined;
    return target && target !== current ? target : undefined;
  }
  switch (strategy) {
    case 'greatest':
      target = maxOf(all);
      break;
    case 'newest': {
      let best: string | undefined;
      let bestT = -Infinity;
      for (const v of all) {
        const t = Date.parse(meta.time[v] ?? '');
        if (!Number.isNaN(t) && t > bestT) {
          bestT = t;
          best = v;
        }
      }
      target = best;
      break;
    }
    case 'minor':
      target = cur ? maxOf(stable(all).filter((v) => semver.major(v) === cur.major)) : undefined;
      break;
    case 'patch':
      target = cur
        ? maxOf(stable(all).filter((v) => semver.major(v) === cur.major && semver.minor(v) === cur.minor))
        : undefined;
      break;
    case 'semver':
      target = range ? (semver.maxSatisfying(all, range) ?? undefined) : undefined;
      break;
    case 'latest':
    default: {
      const latest = meta.distTags.latest;
      if (latest && all.includes(latest)) target = latest;
      else {
        // latest is excluded (cooldown / ignored / deprecated / pin): best stable version below it.
        const pool = stable(all).filter((v) => !latest || !semver.valid(latest) || semver.lte(v, latest));
        target = maxOf(pool);
      }
      // A prerelease current that is ahead of latest: stay on its prerelease line.
      if (cur && cur.prerelease.length && target && semver.lt(target, cur.version)) {
        target = maxOf(all.filter((v) => semver.gt(v, cur.version)));
      }
    }
  }
  if (!target) return undefined;
  if (current && !semver.gt(target, current)) return undefined;
  return target;
}

/** Highest version in `meta` satisfying `range` (for `up pkg@^19`). */
export function resolveRange(meta: PackageMeta, range: string): string | undefined {
  if (meta.versions[range]) return range;
  if (meta.distTags[range]) return meta.distTags[range];
  return semver.maxSatisfying(Object.keys(meta.versions), range) ?? undefined;
}
