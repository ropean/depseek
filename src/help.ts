// Help text: a one-screen overview (`ds -h`), per-command help (`ds <command> -h`, `ds help <command>`)
// and the full option reference (`ds -h --full`, `ds help full`).

type Section = { title: string; lines: string[] };

type SectionName =
  | 'checking'
  | 'registry'
  | 'conflicts'
  | 'format'
  | 'doctor'
  | 'undo'
  | 'writing'
  | 'saving'
  | 'scanning'
  | 'output';

const SECTIONS: Record<SectionName, Section> = {
  checking: {
    title: 'Checking',
    lines: [
      '  -t, --target <t>                    latest | minor | patch | semver | greatest | newest | @<tag>',
      '  -f, --filter <p> / -x, --reject <p> package names: list, globs (@types/*) or /regex/',
      '  --dep <types>                       prod,dev,peer,optional,overrides,packageManager,devEngines',
      '                                      (default prod,dev,optional,packageManager)',
      '  --project <glob>                    only package.json files whose path or name matches',
      '  --level <levels>                    patch,minor,major,prerelease',
      '  -c, --cooldown <period>             ignore versions newer than 7 (days), 7d, 12h or 30m',
      '  -m, --minimal                       skip versions the current range already allows',
      '  --peer                              only versions whose peer dependencies fit the project (both ways)',
      "  --engines-node                      only versions whose engines.node covers the project's engines.node",
      '  --pre <0|1>                         include prereleases for latest / minor / patch targets',
      '  --filter-version / --reject-version only / never dependencies whose written version matches',
      '  --owner-changed                     warn when a different npm account published the target version',
      '  --pin-wildcards                     also resolve "*", "x" and "latest" to a concrete version',
      '  --group-by <g>                      package | project | level (default package)',
      '  --audit                             check current versions against OSV vulnerability data',
      '  --error-on <cond>                   exit 1 on outdated | major | deprecated | peer | conflicts | vulnerable | owner',
      '  -e, --error-level <n>               1: exit 0 unless errors · 2: exit 1 when anything is outdated',
    ],
  },
  registry: {
    title: 'Registry',
    lines: [
      '  -r, --registry <url>                registry to query (default: from .npmrc / bunfig.toml)',
      '  --concurrency <n>                   parallel registry requests (default 16)',
      '  --retry <n> / --timeout <ms>        registry request retries (default 3) and timeout (default 60000)',
      '  --no-cache / --cache-clear          ignore / delete the 10-minute metadata cache',
    ],
  },
  conflicts: {
    title: 'Conflicts',
    lines: [
      '  --fix                               align conflicting versions',
      '  --align <a>                         highest | lowest | most-used | latest | <version> (default highest)',
      '  --allow-major                       allow aligning across major versions',
      '  -i, --interactive                   ask before aligning across major versions',
      '  -c, --cooldown <period>             with --align latest: ignore versions newer than this',
    ],
  },
  format: {
    title: 'Format',
    lines: [
      '  --to <fmt>                          exact | tilde | caret | preserve | gte | x-range',
      '  --from-lock                         use the installed version from the lockfile',
    ],
  },
  doctor: {
    title: 'Doctor',
    lines: [
      '  --test <cmd> / --doctor-test <cmd>  test command (default: <package manager> run test)',
      '  --doctor-install <cmd>              install command run after each upgrade',
    ],
  },
  undo: {
    title: 'Undo',
    lines: [
      '  --list                              list the saved backups instead of restoring',
      '  --force                             restore even if files changed since the write',
    ],
  },
  writing: {
    title: 'Writing',
    lines: [
      '  -u, --upgrade                       write changes to package.json',
      '  -i, --interactive                   pick updates in a full-screen list',
      '  --interactive-select <s>            preselect auto | none | patch | minor | all (default auto)',
      '  -n, --dry-run                       only print the diff',
      '  --format <f>                        exact | tilde | caret | preserve | gte | x-range',
      '                                      default exact: ^1.2.3 → 1.5.0 (ncu keeps ^; use preserve for that)',
      '  --remove-range                      same as --format exact',
      "  --no-diff                           don't print the diff before writing",
      '  --install <mode>                    always | prompt | never (default prompt)',
      '  -p, --package-manager <pm>          npm | pnpm | yarn | bun — use it for every install',
      '  --no-git-check                      allow writing files with uncommitted changes',
      '  --commit[=level]                    git commit the changes (one commit per level with =level)',
      '  -d, --doctor                        same as `depseek doctor`; --doctor-test / --doctor-install <cmd>',
      '  -y, --yes                           assume yes for prompts',
    ],
  },
  saving: {
    title: 'Writing',
    lines: [
      '  -n, --dry-run                       only print the diff',
      "  --no-diff                           don't print the diff before writing",
      '  --install <mode>                    always | prompt | never (default prompt)',
      '  -p, --package-manager <pm>          npm | pnpm | yarn | bun — use it for every install',
      '  --no-git-check                      allow writing files with uncommitted changes',
      '  --commit[=level]                    git commit the changes',
      '  -y, --yes                           assume yes for prompts',
    ],
  },
  scanning: {
    title: "Scanning (always recursive; ncu's --deep / -w / --workspaces are accepted)",
    lines: [
      '  --no-recursive / --depth <n>        only the given directories / limit the depth',
      '  --workspace <name> / --no-root      only these workspaces / leave out the workspace root',
      "  --package-file <glob>               ncu-style file selection, e.g. 'apps/*/package.json'",
      '  -g, --global                        global packages of -p npm (default) | pnpm | yarn | bun',
      '  --include <glob> / --exclude <glob> limit scan scope (repeatable)',
      "  --no-gitignore                      don't honour .gitignore files",
      '  --no-default-ignore                 also scan node_modules-free defaults like fixtures/, examples/',
      '  --follow-symlinks                   follow symbolic links (off by default)',
      '  --list-files [--tree]               only list the package.json files found',
      '  --ascii                             draw trees with ASCII characters',
    ],
  },
  output: {
    title: 'Output',
    lines: [
      '  -o, --output <fmt>                  table | json | markdown',
      '  -j, --json-all / --json-deps / --json-upgraded   ncu-compatible JSON',
      '  -s, --silent / -l, --loglevel <l>   no output / silent | error | warn | info | verbose',
      '  --theme <name> / --color            default | dark | light | colorblind | mono / force colours',
      '  --config <path>                     depseek config (default: auto-detect)',
      '  --config-file-name / --config-file-path   ncu config (.ncurc*, read automatically; --no-ncurc to skip)',
      '  -h, --help [--all] / -v, --version',
    ],
  },
};

type CommandHelp = { usage: string; summary: string; sections: SectionName[] };

export type HelpTopic = 'check' | 'up' | 'conflicts' | 'format' | 'ls' | 'unused' | 'tree' | 'undo' | 'doctor' | 'init';

export const COMMAND_HELP: Record<HelpTopic, CommandHelp> = {
  check: {
    usage: 'depseek [check] [dir...] [pkg...] [options]',
    summary: 'check for updates (read-only); pkg names/globs//regex/ filter',
    sections: ['checking', 'writing', 'registry', 'scanning', 'output'],
  },
  up: {
    usage: 'depseek up [pkg[@ver]...] [dir...]',
    summary: 'update (same as -u); pkg@ver pins every project to it',
    sections: ['checking', 'writing', 'registry', 'scanning', 'output'],
  },
  conflicts: {
    usage: 'depseek conflicts [pkg...]',
    summary: 'versions that differ between projects (--fix to align)',
    sections: ['conflicts', 'saving', 'registry', 'scanning', 'output'],
  },
  format: {
    usage: 'depseek format --to <fmt> [dir...]',
    summary: 'rewrite version prefixes only (--from-lock: use installed)',
    sections: ['format', 'saving', 'scanning', 'output'],
  },
  ls: {
    usage: 'depseek ls [pkg...]',
    summary: 'which projects use a dependency, with which version (alias: list)',
    sections: ['scanning', 'output'],
  },
  unused: {
    usage: 'depseek unused [pkg...]',
    summary: 'dependencies no source file, script or config refers to (exit 1 if any)',
    sections: ['scanning', 'output'],
  },
  tree: {
    usage: 'depseek tree [dir...]',
    summary: 'show where package.json files are, as a tree',
    sections: ['scanning', 'output'],
  },
  undo: {
    usage: 'depseek undo [id] [--list]',
    summary: 'restore package.json files from the last write',
    sections: ['undo', 'output'],
  },
  doctor: {
    usage: 'depseek doctor [--test <cmd>]',
    summary: 'upgrade one package at a time, keep it only if tests pass',
    sections: ['doctor', 'checking', 'writing', 'registry', 'scanning', 'output'],
  },
  init: {
    usage: 'depseek init [--force]',
    summary: 'create depseek.config.json (--force to overwrite)',
    sections: ['output'],
  },
};

export function isHelpTopic(s: string): s is HelpTopic {
  return Object.hasOwn(COMMAND_HELP, s);
}

const pad = (s: string, n: number) => (s.length >= n ? `${s} ` : s.padEnd(n));

function usage(): string[] {
  return [
    'Usage',
    ...Object.entries(COMMAND_HELP).map(([name, c]) => {
      const u = name === 'check' ? 'depseek [dir...] [pkg...] [options]' : c.usage;
      return `  ${pad(u, 36)}${c.summary}`;
    }),
  ];
}

function section(name: SectionName): string[] {
  const s = SECTIONS[name];
  return ['', s.title, ...s.lines];
}

const CAMEL = "Long options also work in ncu's camelCase (--errorLevel, --jsonUpgraded, --packageManager …).";

/** `topic`: undefined → overview, 'all' → every option (--full), a command name → that command's help. */
export function renderHelp(version: string, topic?: HelpTopic | 'all'): string {
  const head = `depseek ${version} — find version conflicts and updates across every package.json`;
  const alias = 'Short command: ds is a short alias of depseek';
  let body: string[];
  if (topic === 'all') {
    body = [
      ...usage(),
      ...(Object.keys(SECTIONS) as SectionName[]).filter((n) => n !== 'saving').flatMap(section),
      '',
      CAMEL,
    ];
  } else if (topic) {
    const c = COMMAND_HELP[topic];
    body = [`Usage: ${c.usage}`, `  ${c.summary}`, ...c.sections.flatMap(section), '', CAMEL];
  } else {
    body = [
      ...usage(),
      '',
      "Run `depseek <command> -h` for one command's options, `depseek -h --full` for every option.",
    ];
  }
  return `${[head, alias, '', ...body].join('\n')}\n`;
}
