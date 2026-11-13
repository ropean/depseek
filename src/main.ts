import pkg from '../package.json' with { type: 'json' };
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
  version: { type: 'boolean', short: 'v' },
  // ncu options that are recognised but not implemented (clear error instead of "unknown option")
  ...Object.fromEntries(
    Object.keys(NCU_UNSUPPORTED).map((k) => [k, { type: 'boolean', optionalValue: true } as OptSpec]),
  ),
};

const COMMANDS = ['check', 'up', 'conflicts', 'format', 'ls', 'tree', 'undo', 'doctor', 'init'] as const;

const HELP: string = `depseek ${pkg.version} — find version conflicts and updates across every package.json

Usage
  depseek [dir...] [pkg...] [options] check for updates (read-only); pkg names/globs//regex/ filter
  depseek up [pkg[@ver]...] [dir...]  update (same as -u); pkg@ver pins every project to it
  depseek conflicts [pkg...]          versions that differ between projects (--fix to align)
  depseek format --to <fmt> [dir...]  rewrite version prefixes only (--from-lock: use installed)
  depseek ls [pkg...]                 which projects use a dependency, with which version
  depseek tree [dir...]               show where package.json files are, as a tree
  depseek undo [id] [--list]          restore package.json files from the last write
  depseek doctor [--test <cmd>]       upgrade one package at a time, keep it only if tests pass
  depseek init                        create depseek.config.json

Checking
  -t, --target <t>                    latest | minor | patch | semver | greatest | newest | @<tag>
  -f, --filter <p> / -x, --reject <p> package names: list, globs (@types/*) or /regex/
  --dep <types>                       prod,dev,peer,optional,overrides,packageManager,devEngines
                                      (default prod,dev,optional,packageManager)
  --project <glob>                    only package.json files whose path or name matches
  --level <levels>                    patch,minor,major,prerelease
  -c, --cooldown <period>             ignore versions newer than 7 (days), 7d, 12h or 30m
  -m, --minimal                       skip versions the current range already allows
  --peer                              only versions whose peer dependencies fit the project (both ways)
  --engines-node                      only versions whose engines.node covers the project's engines.node
  --pre <0|1>                         include prereleases for latest / minor / patch targets
  --filter-version / --reject-version only / never dependencies whose written version matches
  --owner-changed                     warn when a different npm account published the target version
  --pin-wildcards                     also resolve "*", "x" and "latest" to a concrete version
  --group-by <g>                      package | project | level (default package)
  --audit                             check current versions against OSV vulnerability data
  --error-on <cond>                   exit 1 on outdated | major | deprecated | peer | conflicts | vulnerable | owner
  -e, --error-level <n>               1: exit 0 unless errors · 2: exit 1 when anything is outdated
  -r, --registry <url>                registry to query (default: from .npmrc / bunfig.toml)
  --concurrency <n>                   parallel registry requests (default 16)
  --retry <n> / --timeout <ms>        registry request retries (default 3) and timeout (default 60000)
  --no-cache / --cache-clear          ignore / delete the 10-minute metadata cache

Conflicts
  --fix                               align conflicting versions
  --align <a>                         highest | lowest | most-used | latest | <version> (default highest)
  --allow-major                       allow aligning across major versions

Writing
  -u, --upgrade                       write changes to package.json
  -i, --interactive                   pick updates in a full-screen list
  --interactive-select <s>            preselect auto | none | patch | minor | all (default auto)
  -n, --dry-run                       only print the diff
  --format <f>                        exact | tilde | caret | preserve | gte | x-range
                                      default exact: ^1.2.3 → 1.5.0 (ncu keeps ^; use preserve for that)
  --remove-range                      same as --format exact
  --no-diff                           don't print the diff before writing
  --install <mode>                    always | prompt | never (default prompt)
  -p, --package-manager <pm>          npm | pnpm | yarn | bun — use it for every install
  --no-git-check                      allow writing files with uncommitted changes
  --commit[=level]                    git commit the changes (one commit per level with =level)
  -d, --doctor                        same as \`depseek doctor\`; --doctor-test / --doctor-install <cmd>
  -y, --yes                           assume yes for prompts

Scanning (always recursive; ncu's --deep / -w / --workspaces are accepted)
  --no-recursive / --depth <n>        only the given directories / limit the depth
  --workspace <name> / --no-root      only these workspaces / leave out the workspace root
  --package-file <glob>               ncu-style file selection, e.g. 'apps/*/package.json'
  -g, --global                        global packages of -p npm (default) | pnpm | yarn | bun
  --include <glob> / --exclude <glob> limit scan scope (repeatable)
  --no-gitignore                      don't honour .gitignore files
  --no-default-ignore                 also scan node_modules-free defaults like fixtures/, examples/
  --follow-symlinks                   follow symbolic links (off by default)
  --list-files [--tree]               only list the package.json files found
  --ascii                             draw trees with ASCII characters

Output
  -o, --output <fmt>                  table | json | markdown
  -j, --json-all / --json-deps / --json-upgraded   ncu-compatible JSON
  -s, --silent / -l, --loglevel <l>   no output / silent | error | warn | info | verbose
  --theme <name> / --color            default | dark | light | colorblind | mono / force colours
  --config <path>                     depseek config (default: auto-detect)
  --config-file-name / --config-file-path   ncu config (.ncurc*, read automatically; --no-ncurc to skip)
  -h, --help / -v, --version

Long options also work in ncu's camelCase (--errorLevel, --jsonUpgraded, --packageManager …).
`;

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
  if (opts.help) {
    process.stdout.write(HELP);
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

  // ncu style: `depseek react "/^@types/"` filters by package name; directories are scan roots.
  let roots = positionals;
  if (command === 'check' || command === 'doctor') {
    const { dirs, packages } = splitDirsAndPackages(cwd, positionals);
    const pinned = packages.filter((p) => !/^\/.*\/$/.test(p) && p.indexOf('@', p.startsWith('@') ? 1 : 0) > 0);
    if (pinned.length) throw new Error(`To pin versions use \`depseek up ${pinned.join(' ')}\``);
    if (packages.length) opts.filter = [...(list(opts.filter) ?? []), ...packages];
    roots = dirs;
  }

  const ctx: Ctx = createContext(command, opts, roots, cwd);
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
