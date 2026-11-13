import semver from 'semver';

export type SpecKind =
  | 'range'
  | 'workspace'
  | 'file'
  | 'link'
  | 'portal'
  | 'catalog'
  | 'git'
  | 'url'
  | 'wildcard'
  | 'tag'
  | 'reference'
  | 'invalid';

export interface ParsedSpec {
  kind: SpecKind;
  /** The original string. */
  raw: string;
  /** For `npm:real-name@range` aliases: the real package name. */
  alias?: string;
  /** The semver range (aliases: the part after `@`). */
  range?: string;
  /** Simple ranges (`^1.2.3`, `~1.2`, `1.x`, `>=1.0.0`, `1.2.3`) are rewritable. */
  simple?: boolean;
  /** Prefix of a simple range: '', '^', '~', '>=', '='. */
  prefix?: string;
  /** Number of numeric parts given (1–3) for simple ranges; `1.x` → 1. */
  precision?: number;
  /** Simple range contains a wildcard part (`1.x`, `1.4.*`) or omits parts (`1.4`). */
  xRange?: boolean;
  /** The wildcard character used in the original (`x`, `X` or `*`). */
  xChar?: string;
  /** Number of parts written in the original (for `1.x.x` → 3). */
  parts?: number;
  /** Lowest version the range allows (used as "current"). */
  base?: string;
  /** dist-tag name for `kind: 'tag'`. */
  tag?: string;
}

const SIMPLE =
  /^(\^|~|>=|=|v)?\s*(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/** Kinds that are never checked against the registry. */
export const UNCHECKABLE: ReadonlySet<SpecKind> = new Set([
  'workspace',
  'file',
  'link',
  'portal',
  'catalog',
  'git',
  'url',
  'reference',
  'invalid',
]);

function isGit(raw: string): boolean {
  return (
    /^(git\+|git:\/\/|github:|gitlab:|bitbucket:|gist:)/.test(raw) ||
    /\.git(#.*)?$/.test(raw) ||
    /^[\w.-]+\/[\w.-]+(#.*)?$/.test(raw)
  );
}

export function parseSpec(rawInput: string): ParsedSpec {
  const raw = rawInput;
  const s = rawInput.trim();
  if (s.startsWith('workspace:')) return { kind: 'workspace', raw };
  if (s.startsWith('file:')) return { kind: 'file', raw };
  if (s.startsWith('link:')) return { kind: 'link', raw };
  if (s.startsWith('portal:')) return { kind: 'portal', raw };
  if (s.startsWith('catalog:')) return { kind: 'catalog', raw };
  if (s.startsWith('$')) return { kind: 'reference', raw };
  if (s.startsWith('npm:')) {
    const rest = s.slice(4);
    const at = rest.indexOf('@', rest.startsWith('@') ? 1 : 0);
    const alias = at === -1 ? rest : rest.slice(0, at);
    const inner = parseSpec(at === -1 ? '*' : rest.slice(at + 1));
    return { ...inner, raw, alias };
  }
  if (/^https?:\/\//.test(s)) return isGit(s) ? { kind: 'git', raw } : { kind: 'url', raw };
  if (s === '' || s === '*' || s === 'x' || s === 'X' || s === 'latest') return { kind: 'wildcard', raw };
  if (isGit(s) && !semver.validRange(s)) return { kind: 'git', raw };

  const m = SIMPLE.exec(s);
  if (m && semver.validRange(s)) {
    const prefix = m[1] === 'v' ? '' : (m[1] ?? '');
    const nums = [m[2], m[3], m[4]];
    const parts = nums.filter((p) => p !== undefined).length;
    const firstX = nums.findIndex((p) => p === undefined || /[xX*]/.test(p));
    const precision = firstX === -1 ? 3 : firstX;
    const xChar = nums.find((p) => p !== undefined && /[xX*]/.test(p));
    const min = semver.minVersion(s);
    if (precision === 0) return { kind: 'wildcard', raw };
    return {
      kind: 'range',
      raw,
      range: s,
      simple: !m[6] && (precision === 3 || !m[5]),
      prefix,
      precision,
      parts,
      xRange: precision < 3,
      xChar: xChar ?? 'x',
      base: min?.version,
    };
  }
  if (semver.validRange(s)) {
    return { kind: 'range', raw, range: s, simple: false, base: semver.minVersion(s)?.version };
  }
  if (/^[a-z][\w.-]*$/i.test(s)) return { kind: 'tag', raw, tag: s };
  return { kind: 'invalid', raw };
}

export type Format = 'exact' | 'tilde' | 'caret' | 'preserve' | 'gte' | 'x-range';
export const FORMATS: readonly Format[] = ['exact', 'tilde', 'caret', 'preserve', 'gte', 'x-range'];

function xRangeOf(spec: ParsedSpec, version: string): string {
  const v = semver.parse(version)!;
  const x = spec.xChar ?? 'x';
  const precision = spec.kind === 'range' && spec.simple && spec.xRange ? spec.precision! : 2;
  const parts = Math.max(spec.parts ?? 3, precision + 1);
  const nums = [v.major, v.minor, v.patch].slice(0, precision).map(String);
  while (nums.length < parts) nums.push(x);
  return nums.join('.');
}

/**
 * Render `version` in the requested format, keeping alias wrappers (`npm:pkg@…`).
 */
export function formatSpec(spec: ParsedSpec, version: string, format: Format): string {
  let out: string;
  switch (format) {
    case 'exact':
      out = version;
      break;
    case 'tilde':
      out = `~${version}`;
      break;
    case 'caret':
      out = `^${version}`;
      break;
    case 'gte':
      out = `>=${version}`;
      break;
    case 'x-range':
      out = xRangeOf(spec, version);
      break;
    case 'preserve':
    default:
      if (spec.kind === 'range' && spec.simple) {
        out = spec.xRange ? xRangeOf(spec, version) : `${spec.prefix ?? ''}${version}`;
      } else if (spec.kind === 'range') {
        // Complex ranges (">=1 <2", "a || b") can't be preserved; fall back to caret.
        out = `^${version}`;
      } else {
        out = version;
      }
  }
  return spec.alias ? `npm:${spec.alias}@${out}` : out;
}

/** Which format a simple spec is currently written in, if it maps onto one. */
export function detectFormat(spec: ParsedSpec): Format | undefined {
  if (spec.kind !== 'range' || !spec.simple) return undefined;
  if (spec.xRange) return 'x-range';
  switch (spec.prefix) {
    case '':
    case '=':
      return 'exact';
    case '~':
      return 'tilde';
    case '^':
      return 'caret';
    case '>=':
      return 'gte';
  }
  return undefined;
}
