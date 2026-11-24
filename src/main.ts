import pkg from '../package.json' with { type: 'json' };
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { ArgError, list, parseArgv, type OptSpec } from './args.js';
import { checkCommand } from './commands/check.js';
import { globalCommand } from './commands/global.js';
import { conflictsCommand } from './commands/conflicts.js';
import { doctorCommand } from './commands/doctor.js';
import { formatCommand } from './commands/format.js';
import { initCommand } from './commands/init.js';
import { lsCommand } from './commands/ls.js';
import { undoCommand } from './commands/undo.js';
import { splitDirsAndPackages, upCommand } from './commands/up.js';
import { treeCommand } from './commands/tree.js';
import { createContext, type Ctx } from './context.js';
import { isHelpTopic, renderHelp } from './help.js';
import { suggest } from './util/suggest.js';
import { applyNcurc, findNcurc, NCU_UNSUPPORTED, normalizeNcuOptions, readNcurc } from './ncu.js';

const OPTIONS: Record<string, OptSpec> = {
  // scanning
  recursive: { type: 'boolean' },
  depth: { type: 'number' },
  include: { type: 'string', multiple: true },
  exclude: { type: 'string', multiple: true },
  gitignore: { type: 'boolean' },
  'default-ignore': { type: 'boolean' },
  'follow-symlinks': { type: 'boolean' },
  'list-files': { type: 'boolean' },
  tree: { type: 'boolean' },
  ascii: { type: 'boolean' },
  // checking
  upgrade: { type: 'boolean', short: 'u' },
  target: { type: 'string', short: 't' },
  format: { type: 'string' },
  filter: { type: 'string', short: 'f', multiple: true },
  reject: { type: 'string', short: 'x', multiple: true },
  dep: { type: 'string', multiple: true },
  project: { type: 'string', multiple: true },
  level: { type: 'string', multiple: true },
  cooldown: { type: 'string', short: 'c' },
  minimal: { type: 'boolean', short: 'm' },
  peer: { type: 'boolean' },
  'engines-node': { type: 'boolean' },
  pre: { type: 'string' },
  'filter-version': { type: 'string', multiple: true },
  'reject-version': { type: 'string', multiple: true },
  'owner-changed': { type: 'boolean' },
  'pin-wildcards': { type: 'boolean' },
  'group-by': { type: 'string' },
  'error-on': { type: 'string', multiple: true },
  'error-level': { type: 'number', short: 'e' },
  audit: { type: 'boolean' },
  registry: { type: 'string', short: 'r' },
  concurrency: { type: 'number' },
  retry: { type: 'number' },
  timeout: { type: 'number' },
  cache: { type: 'boolean' },
  'cache-clear': { type: 'boolean' },
  // conflicts
  fix: { type: 'boolean' },
  align: { type: 'string' },
  'allow-major': { type: 'boolean' },
  // writing
  interactive: { type: 'boolean', short: 'i' },
  'interactive-select': { type: 'string' },
  'dry-run': { type: 'boolean', short: 'n' },
  diff: { type: 'boolean' },
  install: { type: 'string' },
  'package-manager': { type: 'string', short: 'p' },
  'git-check': { type: 'boolean' },
  commit: { type: 'boolean', optionalValue: true },
  'remove-range': { type: 'boolean' },
  to: { type: 'string' },
  'from-lock': { type: 'boolean' },
  list: { type: 'boolean' },
  test: { type: 'string' },
  doctor: { type: 'boolean', short: 'd' },
  'doctor-test': { type: 'string' },
  'doctor-install': { type: 'string' },
  // ncu workspace / file selection (depseek always scans recursively)
  deep: { type: 'boolean' },
  workspaces: { type: 'boolean', short: 'w' },
  workspace: { type: 'string', multiple: true },
  root: { type: 'boolean' },
  'package-file': { type: 'string', multiple: true },
  global: { type: 'boolean', short: 'g' },
  cwd: { type: 'string' },
  // output
  theme: { type: 'string' },
  output: { type: 'string', short: 'o' },
  'json-all': { type: 'boolean', short: 'j' },
  'json-deps': { type: 'boolean' },
  'json-upgraded': { type: 'boolean' },
  silent: { type: 'boolean', short: 's' },
  loglevel: { type: 'string', short: 'l' },
  verbose: { type: 'boolean' },
  color: { type: 'boolean' },
  config: { type: 'string' },
  'config-file-name': { type: 'string' },
  'config-file-path': { type: 'string' },
  ncurc: { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  full: { type: 'boolean' },
  all: { type: 'boolean' }, // alias of --full
  version: { type: 'boolean', short: 'v' },
  // ncu options that are recognised but not implemented (clear error instead of "unknown option")
  ...Object.fromEntries(
    Object.keys(NCU_UNSUPPORTED).map((k) => [k, { type: 'boolean', optionalValue: true } as OptSpec]),
  ),
};

const COMMANDS = ['check', 'up', 'conflicts', 'format', 'ls', 'tree', 'undo', 'doctor', 'init'] as const;

/** Alternative names for commands. */
const COMMAND_ALIASES: Record<string, (typeof COMMANDS)[number]> = { list: 'ls' };

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgv(argv, OPTIONS);
  } catch (e) {
    if (e instanceof ArgError) {
      process.stderr.write(`depseek: ${e.message}\nRun "depseek --help" for usage.\n`);
      return 2;
    }
    throw e;
  }
  const { opts, positionals } = parsed;
  if (opts.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }
  // `ds list` = `ds ls`, also in `ds help list`
  for (const i of positionals[0] === 'help' ? [1] : [0]) {
    const alias = positionals[i] && Object.hasOwn(COMMAND_ALIASES, positionals[i]!) && COMMAND_ALIASES[positionals[i]!];
    if (alias) positionals[i] = alias;
  }
  // `ds -h`, `ds -h --full`, `ds <command> -h`, `ds help [command|full]`
  const helpCmd = positionals[0] === 'help';
  if (opts.help || helpCmd) {
    const arg = positionals[helpCmd ? 1 : 0];
    if (helpCmd && arg && arg !== 'all' && arg !== 'full' && !isHelpTopic(arg)) {
      process.stderr.write(`depseek: unknown command "${arg}"\nRun "depseek --help" for usage.\n`);
      return 2;
    }
    const topic = opts.full || opts.all || arg === 'full' || arg === 'all' ? 'all' : arg && isHelpTopic(arg) ? arg : undefined;
    process.stdout.write(renderHelp(pkg.version, topic));
    return 0;
  }
  const cwd = opts.cwd ? resolve(String(opts.cwd)) : process.cwd();

  // .ncurc: ncu options as defaults (CLI flags win).
  const notes: string[] = [];
  if (opts.ncurc !== false) {
    const rcFile = findNcurc(cwd, opts);
    if (rcFile) {
      const known = new Set(Object.keys(OPTIONS).map((k) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())));
      for (const k of Object.keys(NCU_UNSUPPORTED))
        known.delete(k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()));
      const ignored = applyNcurc(opts, readNcurc(rcFile), known);
      for (const i of ignored) notes.push(`${relative(cwd, rcFile) || rcFile}: ignoring ${i}`);
    }
  }
  const ncu = normalizeNcuOptions(opts);
  notes.push(...ncu.warnings);

  let command = ncu.command ?? 'check';
  if (positionals.length && (COMMANDS as readonly string[]).includes(positionals[0]!)) command = positionals.shift()!;

  // Not a command, not a directory: probably a typo (it is still used as a package filter).
  const first = positionals[0];
  if (command === 'check' && first && !existsSync(resolve(cwd, first))) {
    const near = suggest(first, COMMANDS.filter((c) => c !== 'check'));
    if (near) notes.push(`unknown command "${first}", did you mean "${near}"? (used as a package filter)`);
  }

  // ncu style: `depseek react "/^@types/"` filters by package name; directories are scan roots.
  let roots = positionals;
  let packageArgs: string[] = [];
  if (command === 'check' || command === 'doctor') {
    const { dirs, packages } = splitDirsAndPackages(cwd, positionals);
    const pinned = packages.filter((p) => !/^\/.*\/$/.test(p) && p.indexOf('@', p.startsWith('@') ? 1 : 0) > 0);
    if (pinned.length) throw new Error(`To pin versions use \`depseek up ${pinned.join(' ')}\``);
    if (packages.length) opts.filter = [...(list(opts.filter) ?? []), ...packages];
    roots = dirs;
    packageArgs = packages;
  }

  const ctx: Ctx = createContext(command, opts, roots, cwd);
  if (packageArgs.length) ctx.packageArgs = packageArgs;
  if (opts.silent) {
    ctx.out = () => {};
    ctx.err = () => {};
    ctx.stdout = () => {};
  }
  // -u with JSON output: only the JSON goes to stdout (diff and progress messages are dropped).
  const writing = command === 'up' || (command === 'check' && (opts.upgrade || opts.interactive));
  if (opts.output === 'json' && writing) ctx.out = () => {};
  for (const n of notes) ctx.err(ctx.painter.paint('warn', `⚠ ${n}`));
  switch (command) {
    case 'tree':
      return treeCommand(ctx, roots, true);
    case 'up':
      return upCommand(ctx, roots);
    case 'conflicts':
      return conflictsCommand(ctx, roots);
    case 'format':
      return formatCommand(ctx, roots);
    case 'ls':
      return lsCommand(ctx, roots);
    case 'undo':
      return undoCommand(ctx, roots);
    case 'doctor':
      return doctorCommand(ctx, roots);
    case 'init':
      return initCommand(ctx);
    case 'check':
    default:
      if (opts.global) return globalCommand(ctx);
      if (opts.listFiles) return treeCommand(ctx, roots, Boolean(opts.tree));
      if (opts.tree) return treeCommand(ctx, roots, true);
      if (opts.upgrade || opts.interactive) return upCommand(ctx, roots, true);
      return checkCommand(ctx, roots);
  }
}
