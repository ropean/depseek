import semver from 'semver';
import type { Update } from '../analyze.js';
import type { Painter, Role } from '../util/color.js';
import type { Level } from '../versions.js';

export const LEVEL_SYMBOL: Record<Level, string> = {
  major: '▲',
  minor: '△',
  patch: '·',
  prerelease: 'β',
};

export function levelLabel(u: Pick<Update, 'level' | 'zero' | 'downgrade'>): string {
  if (u.downgrade) return '▼ downgrade';
  if (u.zero) return `${LEVEL_SYMBOL.major} major (0.x)`;
  return `${LEVEL_SYMBOL[u.level]} ${u.level === 'prerelease' ? 'pre' : u.level}`;
}

export function levelRole(u: Pick<Update, 'level'>): Role {
  return u.level;
}

/**
 * Colour only the part of the new version that changed: `^1.2.3 → ^1.[4.0]`.
 */
export function highlightChange(painter: Painter, current: string | undefined, next: string, role: Role): string {
  const m = /^(.*?)(\d+)\.(\d+|[xX*])(?:\.(\d+|[xX*]))?(.*)$/.exec(next);
  const cur = current ? semver.parse(current) : null;
  if (!m || !cur) return painter.paint(role, next);
  const [, pre, a, b, c, tail] = m;
  const parts = [a!, b!, ...(c !== undefined ? [c] : [])];
  const curParts = [String(cur.major), String(cur.minor), String(cur.patch)];
  let i = 0;
  while (i < parts.length && parts[i] === curParts[i]) i++;
  if (i === parts.length && !tail) return next;
  const head = pre + parts.slice(0, i).join('.') + (i > 0 && i < parts.length ? '.' : '');
  const rest = parts.slice(i).join('.') + (tail ?? '');
  return head + painter.paint(role, rest);
}
