import type { OptValues } from './args.js';
import { list } from './args.js';
import { loadConfig, type Config } from './config.js';
import { scan, type ScanOptions, type ScanResult } from './scan.js';
import { createPainter, type Painter } from './util/color.js';
import { plural } from './util/text.js';

export interface Ctx {
  cwd: string;
  command: string;
  opts: OptValues;
  positionals: string[];
  config: Config;
  configFile?: string;
  painter: Painter;
  out: (s?: string) => void;
  err: (s?: string) => void;
  interactiveTTY: boolean;
}

export function createContext(
  command: string,
  opts: OptValues,
  positionals: string[],
  cwd: string = process.cwd(),
): Ctx {
  const { config, file } = loadConfig(cwd, opts.config as string | undefined);
  const themeCfg = typeof config.theme === 'string' ? { name: config.theme } : (config.theme ?? {});
  const themeName = (opts.theme as string | undefined) ?? themeCfg.name ?? 'default';
  const machine = opts.output === 'json' || opts.output === 'markdown';
  const painter = createPainter(themeName, themeCfg.colors, machine ? false : undefined);
  return {
    cwd,
    command,
    opts,
    positionals,
    config,
    configFile: file,
    painter,
    out: (s = '') => process.stdout.write(`${s}\n`),
    err: (s = '') => process.stderr.write(`${s}\n`),
    interactiveTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  };
}

export function scanOptions(ctx: Ctx, roots: string[]): ScanOptions {
  const o = ctx.opts;
  const s = ctx.config.scan ?? {};
  const ignore = o.defaultIgnore === false ? [] : s.ignore;
  return {
    cwd: ctx.cwd,
    roots,
    recursive: (o.recursive as boolean | undefined) ?? s.recursive,
    depth: (o.depth as number | undefined) ?? s.depth,
    include: list(o.include) ?? s.include,
    exclude: [...(s.exclude ?? []), ...(list(o.exclude) ?? [])],
    ignore,
    gitignore: (o.gitignore as boolean | undefined) ?? s.gitignore,
    followSymlinks: (o.followSymlinks as boolean | undefined) ?? s.followSymlinks,
  };
}

export async function runScan(ctx: Ctx, roots: string[]): Promise<ScanResult> {
  const result = await scan(scanOptions(ctx, roots));
  for (const w of result.warnings) ctx.err(ctx.painter.paint('warn', `⚠ ${w}`));
  return result;
}

export function scanSummary(ctx: Ctx, result: ScanResult): string {
  const names = new Set<string>();
  for (const p of result.projects) for (const d of p.deps) if (d.kind !== 'packageManager') names.add(d.name);
  return ctx.painter.paint(
    'dim',
    `Scanned ${plural(result.projects.length, 'package.json', 'package.json files')}, ${plural(names.size, 'unique dependency', 'unique dependencies')}`,
  );
}
