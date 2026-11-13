/**
 * ANSI styling with theme support. Respects NO_COLOR / FORCE_COLOR and disables colour
 * automatically when the output stream is not a TTY.
 */

const CODES: Record<string, string> = {
  bold: '1',
  dim: '2',
  italic: '3',
  underline: '4',
  inverse: '7',
  black: '30',
  red: '31',
  green: '32',
  yellow: '33',
  blue: '34',
  magenta: '35',
  cyan: '36',
  white: '37',
  gray: '90',
  grey: '90',
  brightRed: '91',
  brightGreen: '92',
  brightYellow: '93',
  brightBlue: '94',
  brightMagenta: '95',
  brightCyan: '96',
  brightWhite: '97',
};

export type Role =
  | 'major'
  | 'minor'
  | 'patch'
  | 'prerelease'
  | 'deprecated'
  | 'high'
  | 'medium'
  | 'low'
  | 'hint'
  | 'dim'
  | 'accent'
  | 'ok'
  | 'warn'
  | 'error'
  | 'path';

export type ThemeSpec = Record<Role, string>;

const base: ThemeSpec = {
  major: 'red',
  minor: 'cyan',
  patch: 'green',
  prerelease: 'magenta',
  deprecated: 'yellow',
  high: 'red bold',
  medium: 'yellow',
  low: 'gray',
  hint: 'blue',
  dim: 'dim',
  accent: 'bold',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  path: 'cyan',
};

export const THEMES: Record<string, ThemeSpec> = {
  default: base,
  dark: {
    ...base,
    major: 'brightRed',
    minor: 'brightCyan',
    patch: 'brightGreen',
    prerelease: 'brightMagenta',
    deprecated: 'brightYellow',
    high: 'brightRed bold',
    medium: 'brightYellow',
    low: 'gray',
    hint: 'brightBlue',
    path: 'brightCyan',
  },
  light: {
    ...base,
    major: '#160',
    minor: '#30',
    patch: '#28',
    prerelease: '#127',
    deprecated: '#136',
    high: '#160 bold',
    medium: '#136',
    low: '#244',
    hint: '#25',
    path: '#30',
  },
  // Red/green-safe: blue / orange palette; symbols and labels carry the meaning as well.
  colorblind: {
    ...base,
    major: '#208 bold',
    minor: '#33',
    patch: '#75',
    prerelease: '#135',
    deprecated: '#220',
    high: '#208 bold',
    medium: '#220',
    low: '#244',
    hint: '#33',
    ok: '#33',
    warn: '#220',
    error: '#208 bold',
    path: '#75',
  },
  mono: {
    major: 'bold underline',
    minor: 'bold',
    patch: '',
    prerelease: 'italic',
    deprecated: 'bold',
    high: 'bold underline',
    medium: 'bold',
    low: '',
    hint: 'italic',
    dim: '',
    accent: 'bold',
    ok: '',
    warn: 'bold',
    error: 'bold',
    path: '',
  },
};

export function shouldUseColor(
  stream: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return !(force === '0' || force === 'false');
  return Boolean(stream.isTTY) && env.TERM !== 'dumb';
}

function styleToCodes(style: string): string[] {
  const out: string[] = [];
  for (const token of style.split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#')) {
      // "#208" → 256-colour foreground
      out.push(`38;5;${token.slice(1)}`);
    } else if (CODES[token]) {
      out.push(CODES[token]!);
    }
  }
  return out;
}

export type Paint = (role: Role, text: string) => string;

export interface Painter {
  enabled: boolean;
  paint: Paint;
  /** Apply an ad-hoc style string, e.g. "bold red". */
  style: (style: string, text: string) => string;
}

export function createPainter(
  themeName = 'default',
  overrides: Partial<ThemeSpec> = {},
  enabled: boolean = shouldUseColor(),
): Painter {
  const theme: ThemeSpec = { ...(THEMES[themeName] ?? THEMES.default!), ...overrides };
  const style = (s: string, text: string): string => {
    if (!enabled || !text) return text;
    const codes = styleToCodes(s);
    return codes.length ? `\x1b[${codes.join(';')}m${text}\x1b[0m` : text;
  };
  return { enabled, style, paint: (role, text) => style(theme[role], text) };
}
