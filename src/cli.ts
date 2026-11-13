#!/usr/bin/env node
import pkg from '../package.json' with { type: 'json' };
import { ArgError, parseArgv, type OptSpec } from './args.js';
import { checkCommand } from './commands/check.js';
import { initCommand } from './commands/init.js';
import { treeCommand } from './commands/tree.js';
import { createContext, type Ctx } from './context.js';

const OPTIONS: Record<string, OptSpec> = {
  // scanning
  recursive: { type: 'boolean', short: 'r' },
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
  project: { type: 'string', short: 'p', multiple: true },
  level: { type: 'string', short: 'l', multiple: true },
  cooldown: { type: 'number' },
  'pin-wildcards': { type: 'boolean' },
  'group-by': { type: 'string', short: 'g' },
  'error-on': { type: 'string', multiple: true },
  concurrency: { type: 'number' },
  cache: { type: 'boolean' },
  // output
  theme: { type: 'string' },
  output: { type: 'string', short: 'o' },
  config: { type: 'string', short: 'c' },
  yes: { type: 'boolean', short: 'y' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

const COMMANDS = ['check', 'tree', 'init'] as const;

const HELP: string = `depseek ${pkg.version} — find version conflicts and updates across every package.json

Usage
  depseek [dir...] [options]          check for updates (read-only)
  depseek tree [dir...]               show where package.json files are, as a tree

Checking
  -t, --target <t>                    latest | minor | patch | semver | greatest | newest | @<tag>
  --format <f>                        exact | tilde | caret | preserve | gte | x-range (default exact)
  -f, --filter <p> / -x, --reject <p> package names: list, globs (@types/*) or /regex/
  --dep <types>                       prod,dev,peer,optional,overrides,packageManager (default prod,dev,optional)
  -p, --project <glob>                only package.json files whose path or name matches
  -l, --level <levels>                patch,minor,major,prerelease
  --cooldown <days>                   ignore versions published in the last N days
  --pin-wildcards                     also resolve "*", "x" and "latest" to a concrete version
  -g, --group-by <g>                  package | project | level (default package)
  --error-on <cond>                   exit 1 on outdated | major | deprecated | peer | conflicts | vulnerable
  --concurrency <n>                   parallel registry requests (default 16)
  --no-cache                          ignore the 10-minute metadata cache

Scanning
  -r, --recursive / --no-recursive    recurse into sub-directories (default on)
  --depth <n>                         max directory depth
  --include <glob> / --exclude <glob> limit scan scope (repeatable)
  --no-gitignore                      don't honour .gitignore files
  --no-default-ignore                 also scan node_modules-free defaults like fixtures/, examples/
  --follow-symlinks                   follow symbolic links (off by default)
  --list-files [--tree]               only list the package.json files found
  --ascii                             draw trees with ASCII characters

Output
  --theme <name>                      default | dark | light | colorblind | mono
  -o, --output <fmt>                  table | json | markdown
  -c, --config <path>                 config file (default: auto-detect)
  -h, --help / -v, --version
`;

async function main(argv: string[]): Promise<number> {
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
  let command = 'check';
  if (positionals.length && (COMMANDS as readonly string[]).includes(positionals[0]!)) command = positionals.shift()!;
  const ctx: Ctx = createContext(command, opts, positionals);
  switch (command) {
    case 'tree':
      return treeCommand(ctx, positionals, true);
    case 'init':
      return initCommand(ctx);
    case 'check':
    default:
      if (opts.listFiles) return treeCommand(ctx, positionals, Boolean(opts.tree));
      if (opts.tree) return treeCommand(ctx, positionals, true);
      return checkCommand(ctx, positionals);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`depseek: ${e instanceof Error ? e.message : String(e)}\n`);
    if (process.env.DEPSEEK_DEBUG && e instanceof Error) process.stderr.write(`${e.stack}\n`);
    process.exitCode = 1;
  },
);
