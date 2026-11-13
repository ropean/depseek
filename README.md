# depseek

English | [简体中文](./README.zh-CN.md)

> npm package: [`@ropean/depseek`](https://www.npmjs.com/package/@ropean/depseek), command: `depseek`

Scan every `package.json` under a directory in one pass (no monorepo required), list **cross-project version conflicts** and **available updates**, and update them in bulk using the version style you choose. Flags, short options, JSON output and `.ncurc` config are compatible with [ncu](https://github.com/raineorshine/npm-check-updates), so it works as a drop-in replacement (see [Migrating from ncu](#migrating-from-ncu)).

[![npm](https://img.shields.io/npm/v/@ropean/depseek.svg)](https://www.npmjs.com/package/@ropean/depseek)
[![CI](https://github.com/ropean/depseek/actions/workflows/ci.yml/badge.svg)](https://github.com/ropean/depseek/actions/workflows/ci.yml)

- **Read-only by default**: without `-u` it only shows results and never touches a file
- **Safe by default**: shows a diff before writing, `--dry-run` shows only the diff; writing requires a clean git working tree, always makes a backup, and `depseek undo` restores it in one step
- **Formatting preserved**: only the version strings are replaced; indentation, line endings, key order and the trailing newline stay as they were
- **Package-manager agnostic**: only reads and writes `package.json`; install runs bun / pnpm / npm / yarn according to each project's lock file (bun when there is no lock file)

Full requirements: [docs/SPEC.md](./docs/SPEC.md) ([简体中文](./docs/SPEC.zh-CN.md)).

## Install

```sh
npm i -g @ropean/depseek     # or pnpm add -g / bun add -g / yarn global add
npx @ropean/depseek --help   # run without installing (same for pnpm dlx / bunx)
```

Two commands are installed: `depseek` and the short alias `ds` (identical; this document uses `depseek`). If `ds` clashes with another command on your machine, just use `depseek`.

```sh
ds                 # = depseek
ds up -i           # = depseek up -i
```

Requires Node.js ≥ 22.

## Quick start

```sh
depseek                                   # check for updates recursively from the current directory (read-only)
depseek tree ~/projects                   # list where each package.json lives, as a tree
depseek conflicts                         # same dependency, different versions across projects
depseek ~/projects --level patch,minor -u # upgrade patch and minor only
depseek up react@19.0.0 react-dom@19.0.0  # set a specific version in every project
depseek -i --format caret                 # pick interactively, write as ^x.y.z
depseek conflicts --fix --align highest   # align to the highest version already in use
depseek format --to exact --from-lock     # change the style only: ^1.2.3 → installed 1.2.7
depseek undo                              # restore the last write
```

## Commands

| Command                              | Purpose                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `depseek [dir...]` / `check`         | List available updates (read-only); `-u` writes, `-i` picks interactively  |
| `depseek up [pkg[@ver]...] [dir...]` | Update, same as `check -u`; `pkg@ver` sets that version/range everywhere   |
| `depseek conflicts [pkg...]`         | List version conflicts; `--fix` aligns them                                |
| `depseek format --to <fmt>`          | Change the version style only, no upgrade; `--from-lock` uses lock files   |
| `depseek ls [pkg...]`                | Which projects use a dependency, and at which version (and installed)      |
| `depseek tree [dir...]`              | Show scanned package.json files as a tree (name, lock, dep count)          |
| `depseek undo [id] [--list]`         | Restore the state before the last (or a given) write                       |
| `depseek doctor [--test <cmd>]`      | Upgrade one by one → install → test, roll back failures, then report       |
| `depseek init`                       | Generate a `depseek.config.json` template                                  |
| `depseek -g [-p pm]`                 | Check globally installed packages (npm / pnpm / yarn / bun); `-u` installs |

### Scan scope

Searches recursively from the current directory by default, skipping `node_modules`, `.git`, `dist`, `build`, `.next`, `.output`, `.wrangler`, `.turbo`, `coverage`, `.cache` as well as `fixtures`, `templates`, `examples` and similar directories, and honours `.gitignore`.

```sh
depseek tree                    # confirm the scan scope first
depseek --list-files            # list file paths only (add --tree to show a tree)
depseek a/ b/ --depth 2 --exclude legacy --include 'apps/**'
depseek --no-gitignore --no-default-ignore --follow-symlinks
```

Sample `depseek tree` output:

```
. (5 package.json)  mono  2 deps  [workspace root, private, bun.lock]
├── packages/ui  @m/ui  2 deps  [workspace]
├── apps/
│   ├── api  @m/api  3 deps  [workspace]
│   └── web  @m/web@1.0.0  4 deps  [workspace]
└── libs  ✖ invalid package.json: Expected double-quoted property name …
    └── deep/nested/x  x  3 deps
```

Chains of directories with a single child are collapsed (`deep/nested/x`); files that fail to parse are marked with ✖ and do not stop the scan. `--ascii` draws with ASCII characters, `-o json` prints a machine-readable list.

### Checking for updates

```
express     4.19.2   →  5.3.0   ▲ major  1 month ago   apps/api
react       ^18.3.1  →  19.3.1  ▲ major  4 weeks ago   apps/web
prettier    ^3.3.0   →  3.10.1  △ minor  1 day ago     .
react       ^19.0.0  →  19.3.1  △ minor  4 weeks ago   libs/x, packages/ui

patch 0 · minor 2 · major 2  in 4 files
```

- The same dependency across projects is merged into one line (`--group-by package`, the default); `--group-by project` groups by file, `--group-by level` by level
- Only the changed part of the target version is coloured; a minor bump on `0.x` counts as breaking (major); prereleases get their own colour
- Every level also has a symbol (▲ △ · β), so it can be told apart without colour
- The footer lists deprecated versions in use, dependencies that cannot be checked (git / URL) and dependencies ignored by config
- `--audit` queries [OSV](https://osv.dev) to flag known vulnerabilities and the versions that fix them

### Write style `--format` and target version `--target`

| `--format`        | Writes          |     | `--target`         | Meaning                                                    |
| ----------------- | --------------- | --- | ------------------ | ---------------------------------------------------------- |
| `exact` (default) | `1.4.2`         |     | `latest` (default) | The registry's `latest` tag                                |
| `tilde`           | `~1.4.2`        |     | `minor`            | Stay within the current major                              |
| `caret`           | `^1.4.2`        |     | `patch`            | Patch bumps only                                           |
| `preserve`        | Keep the prefix |     | `semver`           | Highest version the current range allows (style unchanged) |
| `gte`             | `>=1.4.2`       |     | `greatest`         | Highest version number, prereleases included               |
| `x-range`         | `1.x`           |     | `newest`           | Most recently published version                            |
|                   |                 |     | `@<tag>`           | A specific dist-tag, e.g. `@next`                          |

> **Exact versions by default**: after an upgrade `^1.2.3` becomes `1.5.0`, not `^1.5.0` as with ncu. That way package.json records the version you actually tested, and it will not drift silently on a fresh install. To keep the original `^` / `~`, pass `--format preserve` or set `"format": "preserve"` in the config. When an update would drop a `^` / `~` and no `--format` was given, a one-line hint is printed at the bottom of the output.
>
> Exceptions: the `packageManager` field is always exact (`pnpm@^10` is invalid); `devEngines` keeps its original style (`>=20.0.0` → `>=22.0.0`); `--target semver` never changes the style.

The format can be set per dependency type in the config: `"format": { "prod": "exact", "peer": "caret" }`.

Special specs: `workspace:` / `file:` / `link:` / `portal:` / `catalog:` are skipped; git / URL specs are listed as "cannot check"; `npm:pkg@x` aliases are looked up by the real package name and written back with the alias kept; `*` / `latest` are skipped by default (`--pin-wildcards` turns them into concrete versions); `overrides` / `resolutions` / `pnpm.overrides` are included with `--dep overrides`; `packageManager` is checked with `--dep packageManager`.

### Conflict detection

```
react  ● high · major versions differ
  ^19.0.0  ×2  libs/x, packages/ui (dev)
  ^18.3.1  ×1  apps/web
  → 19.0.0 (within 19.x; --allow-major for all)

zod  ◐ medium · minor / patch differ
typescript  ○ low · written differently
lodash  ℹ hint · dependencies vs devDependencies

3 dependencies have conflicts, 1 across major versions
```

It also reports **unmet peer dependencies** of installed packages, based on `node_modules`. `--fix --align highest|lowest|most-used|latest|<version>` aligns versions; by default it never crosses a major version (each major line is aligned on its own), only with `--allow-major` or after confirming each one in `-i`.

### Filters (shared by check / conflicts / up / format / ls)

| Flag                                    | Description                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `-f, --filter` / `-x, --reject`         | Package names; comma-separated, wildcards (`@types/*`) and `/regex/` supported                                              |
| `--dep <types>`                         | `prod,dev,peer,optional,overrides,packageManager`, default `prod,dev,optional,packageManager`                               |
| `--project <glob>`                      | Only package.json files whose path or `name` matches                                                                        |
| `--level <levels>`                      | `patch,minor,major,prerelease`                                                                                              |
| `-c, --cooldown <period>`               | Ignore recently published versions: `7` (days), `7d`, `12h`, `30m` (avoids versions yanked or poisoned right after release) |
| `-m, --minimal`                         | A version the current range already allows does not count as an update (`^1.2.0` does not suggest 1.5.0)                    |
| `--peer` / `--engines-node`             | Only pick versions whose peer deps are compatible / whose `engines.node` covers the project's (not just a warning)          |
| `--pre 1`                               | Also consider prereleases for the latest / minor / patch targets                                                            |
| `--filter-version` / `--reject-version` | Filter by the version string written in package.json (list or `/regex/`)                                                    |

### Interactive mode `-i`

Grouped by major / minor / patch, with patch and minor pre-selected. `Space` toggles, `a` selects all, `p` / `m` / `M` toggle by level, `/` searches, `→` expands (pick per project, see warnings and the changelog link), `v` / `V` switch to another version, `o` opens the changelog, `Enter` confirms (showing how many dependencies and files will change).

### After writing

- `--install always|prompt|never` (default `prompt`): detects the package manager from each project's lock file, installs workspace members from the workspace root, runs in parallel
- `--commit`: commits the changed package.json and lock files; `--commit=level` writes, installs and commits in batches by patch / minor / major
- `--no-git-check`: allows changing files that have uncommitted changes (a backup is still made)

### Checks before writing

- **Related packages move together**: built-in groups for `react` + `react-dom`, Vue, Angular, vitest, typescript-eslint and more are upgraded to the same version; customise with the `groups` config
- **@types follow their package**: `@types/react` stays on the same major as `react`; `@types/node` follows `runtime.node` / `engines.node`, otherwise it does not cross the current major
- **Peer dependency pre-check**: warns when the upgraded version's peers are not satisfied, or when other packages' peer requirements on it are not (`--peer` excludes such versions instead)
- **Publisher changes**: `--owner-changed` (or `--format ownerChanged`) warns when the target version was published by a different npm account, with special marking when it is that account's first publish; `--error-on owner` for CI
- **engines**: warns when the new version requires a newer Node / Bun
- **License changes**: warns on changes such as MIT → BSL
- **Deprecated**: deprecated versions are never chosen as targets; deprecated versions in use are listed

## Migrating from ncu

Replace `ncu` with `depseek`: ncu's long options (including camelCase spellings such as `--errorLevel`), short options, JSON output such as `--jsonUpgraded`, and `.ncurc` / `.ncurc.{json,yml,yaml,js,cjs,mjs}` config all work as is. The differences: depseek **scans recursively by default** (like ncu's `--deep` / `--workspaces --root`), and writes exact versions by default (see [Write style](#write-style---format-and-target-version---target); `--format preserve` keeps the original prefix, matching ncu).

| ncu                                                                                 | depseek                                       | Notes                                                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ncu react "/^@types/"`                                                             | Same                                          | Positional args: anything that is not a directory is a package-name filter                           |
| `-u` `-i` `-t` `-f` `-x` `--dep`                                                    | Same                                          |                                                                                                      |
| `-c, --cooldown 7d / 12h`                                                           | Same                                          |                                                                                                      |
| `-m, --minimal`                                                                     | Same                                          |                                                                                                      |
| `-e, --errorLevel 2`                                                                | Same (= `--error-on outdated`)                | Also `--error-on major,deprecated,vulnerable…`                                                       |
| `-d, --doctor` `--doctorTest` `--doctorInstall`                                     | Same (= `depseek doctor`)                     |                                                                                                      |
| `-j, --jsonAll` `--jsonDeps` `--jsonUpgraded`                                       | Same; one object per project, grouped by file | Same structure as ncu `--workspaces`                                                                 |
| `-p, --packageManager bun`                                                          | Same                                          | Forces every install to use that package manager                                                     |
| `-r, --registry <url>`                                                              | Same                                          | Reads `.npmrc` / `bunfig.toml` by default                                                            |
| `-s, --silent` / `-l, --loglevel`                                                   | Same                                          |                                                                                                      |
| `--deep` / `-w, --workspaces` / `--root`                                            | Default behaviour                             | `--no-root` excludes the workspace root                                                              |
| `--workspace <name>` / `--packageFile <glob>`                                       | Same                                          | `--project` works too                                                                                |
| `--removeRange`                                                                     | Same (= `--format exact`)                     |                                                                                                      |
| `--format group,time,repo,ownerChanged…`                                            | Accepted; `ownerChanged` = `--owner-changed`  | `lines` is not supported yet                                                                         |
| `--retry` `--timeout` `--concurrency` `--cacheClear`                                | Same                                          |                                                                                                      |
| `-g, --global` (with `-p npm\|pnpm\|yarn\|bun`)                                     | Same; `-u` / `-i` run the global install      | ncu only prints the command; locally linked (`file:`/`link:`) global packages are listed and skipped |
| `--peer`                                                                            | Same, and **solved jointly** across packages  | A plugin and its host can move together to compatible new versions; ncu gets stuck on old ones       |
| `--enginesNode`                                                                     | Same                                          | Falls back to `runtime.node` from the config when there is no `engines.node`                         |
| `--pre 1`                                                                           | Same                                          |                                                                                                      |
| `--filterVersion` / `--rejectVersion`                                               | Same                                          |                                                                                                      |
| `--interactiveSelect auto\|none\|patch\|minor\|all`                                 | Same                                          |                                                                                                      |
| `--dep devEngines`                                                                  | Same                                          | Keeps the original style (`>=20.0.0` → `>=22.0.0`)                                                   |
| `--stdin`, `--packageData`, `--registryType json`, `--mergeConfig`, function config | Not supported; a clear message is printed     |                                                                                                      |

**depseek's former short options now carry ncu's meaning**: use `--group-by` for grouping, `--config` for the config file, `--project` for project filtering, `--level` for levels and `--recursive` for recursion (long options only).

## CI

```sh
depseek --error-on major,deprecated          # exit 1 on major updates or deprecated versions
depseek conflicts --error-on conflicts       # exit 1 on version conflicts
depseek --error-on vulnerable                # known vulnerabilities (enables --audit)
depseek -e 2                                 # ncu style: exit 1 if anything can be upgraded
depseek -o markdown > deps.md                # paste straight into a PR description
depseek -o json | jq '.summary'
```

`--error-on` accepts: `outdated`, `major`, `deprecated`, `peer`, `conflicts`, `vulnerable`, `owner`.

## Configuration

`depseek init` generates `depseek.config.json` (`.depseekrc.json`, `.depseekrc` and a `"depseek"` field in package.json are also supported, searched from the current directory up to the git root). Every CLI flag can be set in the config; the CLI wins.

Existing `.ncurc*` files (current directory → git root → home) are read automatically as defaults for ncu options; unknown or unsupported keys are reported and ignored, `--no-ncurc` turns this off.

```jsonc
{
  "format": { "prod": "exact", "dev": "exact", "peer": "caret" },
  "cooldown": 3,
  "install": "prompt",
  "theme": { "name": "default", "colors": { "major": "red bold", "minor": "#33" } },
  "scan": { "exclude": ["legacy"] },
  "ignore": [{ "name": "eslint", "reason": "migrating to flat config" }],
  "pin": { "typescript": { "range": "~5.6.0", "reason": "waiting for toolchain support" } },
  "ignoreVersions": [{ "spec": "vite@6.1.0", "reason": "HMR bug" }],
  "groups": [["@tanstack/react-query", "@tanstack/react-query-devtools"]],
  "conflicts": {
    "ignore": ["@types/node"],
    "groups": [{ "name": "legacy", "projects": ["legacy/*"] }],
  },
  "runtime": { "node": "22.12.0" },
  "gitCheck": true,
  "audit": false,
}
```

### Registry

Reads `~/.npmrc`, plus every `.npmrc` and `bunfig.toml` (`[install] registry`, `[install.scopes]`) from the git root down to the current directory; supports private scopes, `_authToken` / `_auth` / `username` + `_password`, and `${ENV}` variables. `-r, --registry <url>` overrides the default registry for one run. Each package is fetched once, with 16 concurrent requests by default (`--concurrency`), 3 retries (`--retry`), a 60-second timeout per request (`--timeout <ms>`) and a 10-minute result cache (`--no-cache` forces a refresh, `--cache-clear` empties it, `cacheTtl` in the config, `DEPSEEK_CACHE_DIR` changes the directory).

### Colour themes

`--theme default|dark|light|colorblind|mono`. `colorblind` uses a blue/orange palette, `mono` uses only bold and symbols. Honours `NO_COLOR` / `FORCE_COLOR` and disables colour automatically when writing to a pipe or file.

## Programmatic API

```ts
import {
  scan,
  analyze,
  findConflicts,
  RegistryClient,
  loadRegistryConfig,
  buildSelection,
  selectEntries,
} from '@ropean/depseek';

const { projects } = await scan({ roots: ['.'] });
const selection = buildSelection({}, {});
const entries = selectEntries(projects, selection);
console.log(findConflicts(entries));

const client = new RegistryClient({ config: loadRegistryConfig(process.cwd()) });
const { updates } = await analyze(projects, entries, { client, selection, target: 'minor' });
```

## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md) ([简体中文](./DEVELOPMENT.zh-CN.md)).

## License

MIT
