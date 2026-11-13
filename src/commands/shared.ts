import { list } from '../args.js';
import { analyze, type Analysis, type AnalyzeOptions } from '../analyze.js';
import type { Ctx } from '../context.js';
import { runScan, scanSummary } from '../context.js';
import { loadRegistryConfig, RegistryClient } from '../registry.js';
import type { ScanResult } from '../scan.js';
import { buildSelection, selectEntries, type Selection } from '../select.js';
import { FORMATS, type Format } from '../spec.js';
import { TARGETS } from '../versions.js';

export interface Prepared {
  result: ScanResult;
  selection: Selection;
  client: RegistryClient;
}

export function getFormat(ctx: Ctx, key = 'format'): Format | undefined {
  const f = ctx.opts[key] as string | undefined;
  if (f === undefined) return undefined;
  if (!(FORMATS as readonly string[]).includes(f))
    throw new Error(`Unknown format "${f}" (expected ${FORMATS.join(', ')})`);
  return f as Format;
}

export function getTarget(ctx: Ctx): string {
  const t = (ctx.opts.target as string | undefined) ?? ctx.config.target ?? 'latest';
  if (!t.startsWith('@') && !TARGETS.includes(t))
    throw new Error(`Unknown target "${t}" (expected ${TARGETS.join(', ')} or @<tag>)`);
  return t;
}

export function createClient(ctx: Ctx, dir: string): RegistryClient {
  return new RegistryClient({
    config: loadRegistryConfig(dir),
    concurrency: (ctx.opts.concurrency as number | undefined) ?? ctx.config.concurrency ?? 16,
    cacheTtl: ctx.config.cacheTtl ?? 10,
    useCache: ctx.opts.cache !== false,
  });
}

export async function prepare(ctx: Ctx, roots: string[]): Promise<Prepared | undefined> {
  const result = await runScan(ctx, roots);
  if (!result.projects.length) {
    ctx.err('No package.json found.');
    return undefined;
  }
  const selection = buildSelection(ctx.opts, ctx.config);
  return { result, selection, client: createClient(ctx, result.roots[0] ?? ctx.cwd) };
}

export function progress(ctx: Ctx, label: string): { tick: (done: number, total: number) => void; done: () => void } {
  const tty = Boolean(process.stderr.isTTY) && ctx.opts.output !== 'json';
  let last = 0;
  return {
    tick: (done, total) => {
      if (!tty) return;
      const now = Date.now();
      if (now - last < 50 && done < total) return;
      last = now;
      process.stderr.write(`\r\x1b[K${ctx.painter.paint('dim', `${label} ${done}/${total}`)}`);
    },
    done: () => {
      if (tty) process.stderr.write('\r\x1b[K');
    },
  };
}

export function analyzeOptions(ctx: Ctx, prep: Prepared, extra: Partial<AnalyzeOptions> = {}): AnalyzeOptions {
  const c = ctx.config;
  return {
    client: prep.client,
    selection: prep.selection,
    target: getTarget(ctx),
    format: getFormat(ctx),
    formatConfig: c.format,
    cooldown: (ctx.opts.cooldown as number | undefined) ?? c.cooldown ?? 0,
    pinWildcards: Boolean(ctx.opts.pinWildcards),
    pins: c.pin,
    ignoreVersions: c.ignoreVersions,
    groups: c.groups,
    builtinGroups: c.builtinGroups,
    runtime: c.runtime,
    licenseCheck: c.licenseCheck,
    audit: (ctx.opts.audit as boolean | undefined) ?? c.audit ?? false,
    ...extra,
  };
}

export async function runAnalysis(ctx: Ctx, prep: Prepared, extra: Partial<AnalyzeOptions> = {}): Promise<Analysis> {
  const entries = selectEntries(prep.result.projects, prep.selection);
  const bar = progress(ctx, 'Checking registry');
  try {
    return await analyze(prep.result.projects, entries, analyzeOptions(ctx, prep, { onProgress: bar.tick, ...extra }));
  } finally {
    bar.done();
  }
}

export function printSummary(ctx: Ctx, result: ScanResult): void {
  if (ctx.opts.output === 'json' || ctx.opts.output === 'markdown') return;
  ctx.out(scanSummary(ctx, result));
  ctx.out();
}

export type ErrorOn = 'outdated' | 'major' | 'deprecated' | 'peer' | 'conflicts' | 'vulnerable';
const ERROR_ON: readonly ErrorOn[] = ['outdated', 'major', 'deprecated', 'peer', 'conflicts', 'vulnerable'];

export function errorOn(ctx: Ctx): Set<ErrorOn> {
  const l = list(ctx.opts.errorOn) ?? [];
  // --error-on vulnerable implies --audit
  if (l.includes('vulnerable') && ctx.opts.audit === undefined) ctx.opts.audit = true;
  for (const x of l)
    if (!(ERROR_ON as readonly string[]).includes(x))
      throw new Error(`Unknown --error-on "${x}" (expected ${ERROR_ON.join(', ')})`);
  return new Set(l as ErrorOn[]);
}

export function analysisFails(conds: Set<ErrorOn>, a: Analysis): string[] {
  const why: string[] = [];
  if (conds.has('outdated') && a.updates.length) why.push('outdated dependencies');
  if (conds.has('major') && a.updates.some((u) => u.level === 'major')) why.push('major updates');
  if (
    conds.has('deprecated') &&
    (a.deprecated.length || a.updates.some((u) => u.warnings.some((w) => w.type === 'deprecated')))
  )
    why.push('deprecated versions');
  if (conds.has('peer') && a.updates.some((u) => u.warnings.some((w) => w.type === 'peer')))
    why.push('peer dependency problems');
  if (conds.has('vulnerable') && a.updates.some((u) => u.warnings.some((w) => w.type === 'vulnerable')))
    why.push('vulnerabilities');
  return why;
}

export function parsePackageArgs(args: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of args) {
    const at = a.indexOf('@', a.startsWith('@') ? 1 : 0);
    if (at === -1) m.set(a, '');
    else m.set(a.slice(0, at), a.slice(at + 1));
  }
  return m;
}
