/**
 * npm-check-updates compatibility: ncu option names, short flags, values and `.ncurc` files are
 * translated into depseek options, so `ncu …` command lines and CI scripts keep working.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { list, type OptValues } from './args.js';
import { cacheDir } from './registry.js';

/** Values of ncu's `--format` (display options) — depseek's `--format` is the version style. */
export const NCU_DISPLAY_FORMATS: readonly string[] = [
  'group',
  'no-group',
  'dep',
  'ownerChanged',
  'repo',
  'time',
  'lines',
  'installedVersion',
  'cooldown',
];

/** ncu options depseek does not implement (yet): a clear message instead of "unknown option". */
export const NCU_UNSUPPORTED: Record<string, string> = {
  'filter-results': 'predicate functions are not supported',
  'group-function': 'predicate functions are not supported',
  'merge-config': 'planned',
  stdin: 'depseek reads package.json files from disk',
  'package-data': 'depseek reads package.json files from disk',
  'registry-type': 'only npm-compatible registries are supported',
  prefix: 'pass the directory as an argument instead',
};

export type NcuJson = 'all' | 'deps' | 'upgraded';

/** "7" → 7 days, "7d" / "12h" / "30m" → days (fractional). */
export function parseCooldown(v: unknown): number | undefined {
  if (v === undefined || v === false) return undefined;
  if (typeof v === 'number') return v;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([dhm]?)\s*$/i.exec(String(v));
  if (!m) throw new Error(`--cooldown expects days or a duration like 7d, 12h, 30m — got "${String(v)}"`);
  const n = Number(m[1]);
  const unit = m[2]!.toLowerCase();
  return unit === 'h' ? n / 24 : unit === 'm' ? n / 1440 : n;
}

export interface NcuResult {
  /** Command implied by an ncu flag (`--doctor` → doctor). */
  command?: string;
  warnings: string[];
}

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

/**
 * Translate ncu-style options (from argv or .ncurc) in place. Runs before the context is created.
 */
export function normalizeNcuOptions(opts: OptValues): NcuResult {
  const warnings: string[] = [];
  let command: string | undefined;

  for (const key of Object.keys(NCU_UNSUPPORTED)) {
    const camel = key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (opts[camel] !== undefined) throw new Error(`ncu option --${camel} is not supported: ${NCU_UNSUPPORTED[key]}`);
  }

  if (opts.cooldown !== undefined) opts.cooldown = parseCooldown(opts.cooldown);
  if (opts.pre !== undefined) opts.pre = opts.pre === true || Number(opts.pre) > 0;
  if (opts.interactiveSelect !== undefined) {
    const v = String(opts.interactiveSelect);
    if (!['auto', 'none', 'patch', 'minor', 'all'].includes(v))
      throw new Error(`--interactiveSelect expects auto, none, patch, minor or all — got "${v}"`);
  }

  // -e 2: exit 1 when anything is outdated.
  if (opts.errorLevel !== undefined) {
    const lvl = Number(opts.errorLevel);
    if (lvl !== 1 && lvl !== 2) throw new Error(`--errorLevel expects 1 or 2, got "${String(opts.errorLevel)}"`);
    if (lvl === 2) opts.errorOn = [...(list(opts.errorOn) ?? []), 'outdated'];
  }

  const loglevel = opts.loglevel as string | undefined;
  if (opts.silent || loglevel === 'silent') opts.silent = true;
  if (loglevel === 'verbose' || loglevel === 'silly' || opts.verbose) process.env.DEPSEEK_DEBUG ??= '1';

  // ncu --format is about display; depseek's --format is the version style. Their values don't overlap.
  if (opts.format !== undefined) {
    const vals = list(opts.format) ?? [];
    const display = vals.filter((v) => NCU_DISPLAY_FORMATS.includes(v));
    if (display.length) {
      if (display.length !== vals.length)
        throw new Error(`--format: don't mix ncu display values (${display.join(', ')}) with a version style`);
      opts.format = undefined;
      for (const d of display) {
        if (d === 'ownerChanged') opts.ownerChanged = true;
        if (d === 'lines') warnings.push('--format lines is not supported yet; ignored');
        // group / time / repo / dep / installedVersion / cooldown: shown by default (or in -o json).
      }
    }
  }
  if (opts.removeRange && opts.format === undefined) opts.format = 'exact';

  if (opts.doctor) command = 'doctor';
  if (opts.doctorTest !== undefined) opts.test ??= opts.doctorTest;

  // Workspaces: depseek always scans recursively, so --deep / --workspaces are the default.
  const projects = list(opts.project) ?? [];
  for (const w of list(opts.workspace) ?? []) projects.push(w);
  for (const f of list(opts.packageFile) ?? []) {
    const dir = f.replace(/\\/g, '/').replace(/(^|\/)package\.json$/, '');
    if (dir === '' || dir === '.') projects.push('.');
    else if (dir !== '**') projects.push(dir.replace(/\/\*\*$/, '/**'));
  }
  if (projects.length) opts.project = projects;
  if (opts.root === false) opts.noRoot = true;

  const pm = opts.packageManager as string | undefined;
  if (pm !== undefined && !PACKAGE_MANAGERS.includes(pm))
    throw new Error(`--packageManager "${pm}" is not supported (expected ${PACKAGE_MANAGERS.join(', ')})`);

  if (opts.color) process.env.FORCE_COLOR ??= '1';

  if (opts.cacheClear) rmSync(join(cacheDir(), 'packuments'), { recursive: true, force: true });

  const json: NcuJson | undefined = opts.jsonAll
    ? 'all'
    : opts.jsonDeps
      ? 'deps'
      : opts.jsonUpgraded
        ? 'upgraded'
        : undefined;
  if (json) {
    opts.ncuJson = json;
    opts.output = 'json';
    opts.install ??= 'never';
  }

  return { command, warnings };
}

/** ncu config file names, in ncu's lookup order. */
export const NCURC_FILES: readonly string[] = [
  '.ncurc',
  '.ncurc.json',
  '.ncurc.yml',
  '.ncurc.yaml',
  '.ncurc.js',
  '.ncurc.cjs',
  '.ncurc.mjs',
];

/** Find the ncu config: --configFilePath / --configFileName, else cwd → git root, else home. */
export function findNcurc(cwd: string, opts: OptValues): string | undefined {
  const names = opts.configFileName ? [String(opts.configFileName)] : NCURC_FILES;
  if (opts.configFilePath) {
    const dir = resolve(cwd, String(opts.configFilePath));
    const hit = names.map((n) => join(dir, n)).find((f) => existsSync(f));
    if (!hit) throw new Error(`No ncu config (${names.join(', ')}) in ${dir}`);
    return hit;
  }
  let dir = resolve(cwd);
  for (;;) {
    const hit = names.map((n) => join(dir, n)).find((f) => existsSync(f));
    if (hit) return hit;
    if (existsSync(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return names.map((n) => join(homedir(), n)).find((f) => existsSync(f));
}

/** Minimal YAML for .ncurc.yml: `key: value`, inline `[a, b]` lists and `- item` lists. */
export function parseSimpleYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let listKey: string | undefined;
  const scalar = (raw: string): unknown => {
    const v = raw.trim().replace(/\s+#.*$/, '');
    if (/^(['"]).*\1$/.test(v)) return v.slice(1, -1);
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v === 'null' || v === '~' || v === '') return undefined;
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    if (v.startsWith('[') && v.endsWith(']'))
      return v
        .slice(1, -1)
        .split(',')
        .map((x) => scalar(x))
        .filter((x) => x !== undefined);
    return v;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(line)) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) ?? /^-\s+(.*)$/.exec(line);
    if (item && listKey) {
      (out[listKey] as unknown[]).push(scalar(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) throw new Error(`unsupported YAML line: ${line.trim()}`);
    const value = scalar(kv[2]!);
    if (value === undefined && kv[2]!.trim() === '') {
      listKey = kv[1]!;
      out[listKey] = [];
    } else {
      listKey = undefined;
      out[kv[1]!] = value;
    }
  }
  return out;
}

export function readNcurc(file: string): Record<string, unknown> {
  try {
    if (/\.(c|m)?js$/.test(file)) {
      const mod = createRequire(import.meta.url)(file) as Record<string, unknown> & { default?: unknown };
      const cfg = (mod.default ?? mod) as Record<string, unknown>;
      return typeof cfg === 'function' ? ((cfg as () => Record<string, unknown>)() ?? {}) : cfg;
    }
    const text = readFileSync(file, 'utf8');
    if (/\.ya?ml$/.test(file)) return parseSimpleYaml(text);
    const t = text.trim();
    return t.startsWith('{') ? (JSON.parse(t) as Record<string, unknown>) : parseSimpleYaml(text);
  } catch (e) {
    throw new Error(`Invalid ncu config ${file}: ${(e as Error).message}`);
  }
}

/**
 * Copy option keys from a .ncurc onto parsed CLI options (CLI wins). `known` is the set of accepted
 * option names (camelCase). Returns the keys that were ignored, with the reason.
 */
export function applyNcurc(opts: OptValues, rc: Record<string, unknown>, known: Set<string>): string[] {
  const ignored: string[] = [];
  for (const [rawKey, value] of Object.entries(rc)) {
    if (rawKey === '$schema') continue;
    const key = rawKey.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    if (key === 'configFileName' || key === 'configFilePath' || key === 'cwd') continue;
    if (typeof value === 'function') {
      ignored.push(`${rawKey} (functions are not supported)`);
      continue;
    }
    const kebabKey = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    if (NCU_UNSUPPORTED[kebabKey]) {
      ignored.push(`${rawKey} (${NCU_UNSUPPORTED[kebabKey]})`);
      continue;
    }
    if (!known.has(key)) {
      ignored.push(`${rawKey} (unknown option)`);
      continue;
    }
    if (opts[key] !== undefined || value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.some((v) => typeof v !== 'string' && typeof v !== 'number')) {
        ignored.push(`${rawKey} (only string lists are supported)`);
        continue;
      }
      opts[key] = value.map(String);
    } else if (typeof value === 'object') {
      ignored.push(`${rawKey} (objects are not supported)`);
    } else opts[key] = value as string | number | boolean;
  }
  return ignored;
}
