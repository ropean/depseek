/**
 * Small argv parser: long/short flags, `--flag=value`, `--no-flag`, repeated options and
 * combined short booleans (`-ui`). Unknown options are errors.
 */

export interface OptSpec {
  type: 'boolean' | 'string' | 'number';
  short?: string;
  multiple?: boolean;
  /** Boolean flag whose value may optionally follow (`--commit` or `--commit=level`). */
  optionalValue?: boolean;
}

export type OptValues = Record<string, string | boolean | number | string[] | undefined>;

export class ArgError extends Error {}

const camel = (s: string): string => s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function parseArgv(argv: string[], specs: Record<string, OptSpec>): { opts: OptValues; positionals: string[] } {
  const opts: OptValues = {};
  const positionals: string[] = [];
  const byShort = new Map(Object.entries(specs).flatMap(([k, s]) => (s.short ? [[s.short, k] as const] : [])));

  const set = (name: string, spec: OptSpec, value: string | boolean): void => {
    const key = camel(name);
    if (spec.type === 'number' && typeof value === 'string') {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ArgError(`--${name} expects a number, got "${value}"`);
      opts[key] = n;
    } else if (spec.multiple && typeof value === 'string') {
      const prev = opts[key];
      opts[key] = [...(Array.isArray(prev) ? prev : []), value];
    } else opts[key] = value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      let name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inline = eq === -1 ? undefined : arg.slice(eq + 1);
      let spec = specs[name];
      if (!spec && name.startsWith('no-') && specs[name.slice(3)]) {
        name = name.slice(3);
        spec = specs[name]!;
        if (inline !== undefined) throw new ArgError(`--no-${name} does not take a value`);
        opts[camel(name)] = false;
        continue;
      }
      if (!spec) throw new ArgError(`Unknown option: --${name}`);
      if (spec.type === 'boolean') {
        if (inline !== undefined) {
          if (spec.optionalValue) set(name, spec, inline);
          else set(name, spec, !/^(false|0|no)$/i.test(inline));
        } else set(name, spec, true);
      } else {
        const v = inline ?? argv[++i];
        if (v === undefined) throw new ArgError(`--${name} requires a value`);
        set(name, spec, v);
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1 && !/^-\d/.test(arg)) {
      const letters = arg.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const name = byShort.get(letters[j]!);
        if (!name) throw new ArgError(`Unknown option: -${letters[j]}`);
        const spec = specs[name]!;
        if (spec.type === 'boolean') set(name, spec, true);
        else {
          const rest = letters.slice(j + 1);
          const v = rest || argv[++i];
          if (v === undefined) throw new ArgError(`-${letters[j]} requires a value`);
          set(name, spec, v);
          break;
        }
      }
      continue;
    }
    positionals.push(arg);
  }
  return { opts, positionals };
}

/** Split repeated and comma-separated list options into a flat array. */
export function list(v: unknown): string[] | undefined {
  if (v === undefined || v === false) return undefined;
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .flatMap((x) => String(x).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
}
