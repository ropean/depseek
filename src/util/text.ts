// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Display width in terminal columns (ANSI codes ignored, CJK counted as 2). */
export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += isWide(ch.codePointAt(0)!) ? 2 : 1;
  return w;
}

export function padEnd(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : s + ' '.repeat(n - w);
}

export function padStart(s: string, n: number): string {
  const w = width(s);
  return w >= n ? s : ' '.repeat(n - w) + s;
}

export interface TableOptions {
  indent?: string;
  gap?: string;
  align?: ('left' | 'right')[];
}

/** Render rows as aligned columns. The last column is never padded. */
export function table(rows: string[][], opts: TableOptions = {}): string {
  const { indent = '', gap = '  ', align = [] } = opts;
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, width(cell))));
  return rows
    .map((row) =>
      (
        indent +
        row
          .map((cell, i) => {
            if (i === row.length - 1 && align[i] !== 'right') return cell;
            return align[i] === 'right' ? padStart(cell, widths[i]!) : padEnd(cell, widths[i]!);
          })
          .join(gap)
      ).trimEnd(),
    )
    .join('\n');
}

export function relativeTime(date: Date | string | undefined, now: number = Date.now()): string {
  if (!date) return '';
  const t = typeof date === 'string' ? Date.parse(date) : date.getTime();
  if (Number.isNaN(t)) return '';
  const sec = Math.round((now - t) / 1000);
  if (sec < 0) return 'just now';
  const units: [number, string][] = [
    [60 * 60 * 24 * 365, 'year'],
    [60 * 60 * 24 * 30, 'month'],
    [60 * 60 * 24 * 7, 'week'],
    [60 * 60 * 24, 'day'],
    [60 * 60, 'hour'],
    [60, 'minute'],
  ];
  for (const [s, name] of units) {
    if (sec >= s) {
      const n = Math.floor(sec / s);
      return `${n} ${name}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Join a list, truncating with "+N more". */
export function listShort(items: string[], max = 3): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

export function toPosix(p: string): string {
  return p.split('\\').join('/');
}
