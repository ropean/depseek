# Dependency Scanning and Version Alignment CLI — Requirements Spec

English | [简体中文](./SPEC.zh-CN.md)

Nov 13, 2026 · @Wei Guo

## Overview

A CLI that scans every package.json under a directory in one pass (no monorepo required), lists version conflicts and available updates, and can update them in bulk using a chosen version style. The interaction model follows ncu, plus cross-project conflict detection and alignment, which ncu does not have. The command is `depseek`.

**Design principles**

- **Read-only by default**: without `-u` it only shows results and never touches a file.
- **Safe by default**: show a diff before writing files; support `--dry-run`; back up or require a clean git working tree before changing anything.
- **Formatting preserved**: keep the original indentation, line endings, key order and trailing newline when writing back; only change version strings.
- **Package-manager agnostic**: only read and write package.json; leave install to the package manager the user chooses (bun detected by default).
- **Zero learning curve for ncu users**: long/short flags, JSON output and `.ncurc` config are compatible with ncu; replacing `ncu` with `depseek` is enough (see [Migrating from ncu](../README.md#migrating-from-ncu) in the README).

**Main differences from ncu**

| Aspect                | ncu                            | This tool                                                      |
| --------------------- | ------------------------------ | -------------------------------------------------------------- |
| Multiple package.json | `--deep` shows them one by one | Aggregated view; the same dependency is merged across projects |
| Version conflicts     | Not detected                   | Core feature                                                   |
| Write style           | Keeps the original prefix      | Can enforce exact / \~ / ^ etc.                                |
| Aligning versions     | Not supported                  | One command aligns every project                               |

## Scanning

Finds every package.json recursively from the current directory by default.

**Requested**

- Directories: `depseek [dir...]`, default `.`, multiple allowed.
- Recursion: recursive by default; `--no-recursive` looks only at the directory itself.

**Additions**

- **Depth limit**: `--depth <n>`, to avoid scanning too deep.
- **Default ignores**: `node_modules`, `.git`, `dist`, `build`, `.next`, `.output`, `.wrangler`, `.turbo`, `coverage`, `.cache`.
- **Honour .gitignore**: on by default, `--no-gitignore` turns it off. Automatically excludes generated files and temp directories.
- **Custom include/exclude**: `--include <glob>`, `--exclude <glob>`, repeatable.
- **Do not follow symlinks**: off by default, to avoid loops and duplicate scans.
- **Skip templates and test fixtures**: package.json files in `fixtures/`, `templates/`, `examples/` usually should not be touched; these should be in the default ignore list, configurable.
- **Fault tolerance**: files that fail to parse as JSON produce a warning and are skipped without aborting the scan.
- **Project info**: record each package.json's `name`, relative path and the adjacent lock file type (bun.lock / package-lock.json / pnpm-lock.yaml / yarn.lock), for display and later installs.
- **Workspace detection**: if a package.json has a `workspaces` field, mark its sub-packages and exclude internal dependencies such as `workspace:*` from updates.
- **Scan summary**: start with "Found N package.json files, M distinct dependencies"; `--list-files` lists only the files found, to confirm the scan scope.
- **Tree of locations**: `depseek tree [dir...]` (or `--list-files --tree`) shows where each package.json lives as a directory tree, with `name@version`, dependency count, lock file and workspace role; chains of single-child directories are collapsed (e.g. `deep/nested/x`), files that fail to parse are marked with ✖. `--ascii` draws with ASCII, `-o json` prints a list.

```
. (5 package.json)  mono  2 deps  [workspace root, private, bun.lock]
├── packages/ui  @m/ui  2 deps  [workspace]
├── apps/
│   ├── api  @m/api  3 deps  [workspace]
│   └── web  @m/web@1.0.0  4 deps  [workspace]
└── libs  ✖ invalid package.json
    └── deep/nested/x  x  3 deps
```

## Conflict detection

`depseek conflicts` lists dependencies whose versions differ between package.json files, grouped by dependency name.

**Conflict types**

| Type                      | Example                                                                   | Severity        |
| ------------------------- | ------------------------------------------------------------------------- | --------------- |
| Different major           | A uses `react@^18.3.1`, B uses `react@^19.0.0`                            | High (red)      |
| Different minor/patch     | A uses `zod@^3.22.0`, B uses `zod@^3.24.1`                                | Medium (yellow) |
| Written differently       | A uses `~5.6.2`, B uses `5.6.2`                                           | Low (grey)      |
| Different dependency type | A has it in dependencies, B in devDependencies                            | Hint            |
| Unmet peer                | The installed version does not satisfy a package's peerDependencies range | High (red)      |

**Display**

- One group per conflicting dependency, listing each version and the project paths using it, versions sorted by usage count, most first.
- Mark the suggested alignment target (by default the highest version in use).
- Footer summary: X dependencies have conflicts, Y of them across major versions.

**Aligning (fix)**

`depseek conflicts --fix` aligns each conflicting dependency to one version; the target can be:

- `--align highest` (default): the highest version already used by any project
- `--align lowest`: the lowest version, the most conservative
- `--align most-used`: the most used version
- `--align latest`: the latest version on the registry
- `--align <version>`: only for a single package, e.g. `depseek conflicts react --fix --align 19.0.0`

Alignment does not cross major versions by default; crossing requires `--allow-major` or confirming each one in interactive mode. The config can declare dependencies or project groups that are "allowed to differ" (see the config file).

## Checking for updates

`depseek check` (the default when no subcommand is given) lists available updates, grouped and coloured by upgrade level.

**Update levels and default colours**

| Level        | Meaning                                            | Default colour  |
| ------------ | -------------------------------------------------- | --------------- |
| major        | Major version change, may contain breaking changes | Red             |
| minor        | Minor version, new features                        | Cyan            |
| patch        | Patch, bug fixes                                   | Green           |
| minor on 0.x | E.g. `0.3 → 0.4`, breaking by semver convention    | Red             |
| prerelease   | beta / rc / canary                                 | Magenta         |
| Deprecated   | The current or target version is deprecated        | Yellow + marker |

**Output**

- Each line: package name, current range, →, target version, level, publish time (e.g. "3 days ago").
- Only the changed part of the target version is coloured, e.g. `1.2.3 → 1.`**`4.0`**, so the changed segment is obvious at a glance.
- Two grouping views: `--group-by package` (default; the same dependency across projects is one line followed by the affected projects) and `--group-by project` (one block per package.json, like ncu --deep).
- `--group-by level`: blocks by major / minor / patch.
- Footer: X patch, Y minor, Z major.

**Colour themes**

- Built-in themes: `default`, `dark`, `light`, `colorblind` (red-green colour-blind friendly, blue/orange plus symbols), `mono` (no colour, only bold and symbols).
- `--theme <name>` switches; the config file can customise the colour of each level.
- Besides colour, every level has a text label or symbol, so it can be told apart without colour.
- Honour the `NO_COLOR` / `FORCE_COLOR` environment variables, and disable colour automatically when writing to a pipe or file.

**Version lookup**

- Fetch metadata from the registry concurrently, configurable (`--concurrency`, default 16).
- Each package is fetched once, even if it appears in many package.json files.
- Cache results locally, valid for 10 minutes by default; `--no-cache` forces a refresh.
- Read registry and private scope settings from `.npmrc` and `bunfig.toml`, including private registries with tokens.

## Updating

An update consists of two independent choices: **which version to move to** (target) and **how to write the version** (format). `depseek -u` or `depseek up` writes.

**Write style (`--format`)**

| Format            | Result          | Notes                                                                |
| ----------------- | --------------- | -------------------------------------------------------------------- |
| `exact` (default) | `1.4.2`         | The requested default; pins a specific version                       |
| `tilde`           | `~1.4.2`        | Allows later patches                                                 |
| `caret`           | `^1.4.2`        | Allows later minors and patches                                      |
| `preserve`        | Keep the prefix | `^` stays `^`, matching ncu                                          |
| `gte`             | `>=1.4.2`       | Rarely used; suits a library's peerDependencies                      |
| `x-range`         | `1.x` / `1.4.x` | Keeps the wildcard at its original precision, only bumps major/minor |

**Per-dependency-type formats** are recommended, e.g. `exact` for an app's dependencies and `caret` for a library's peerDependencies. In the config: `format: { dependencies: "exact", peerDependencies: "caret" }`.

**Target version (`--target`, following ncu)**

| Target             | Meaning                                                                           |
| ------------------ | --------------------------------------------------------------------------------- |
| `latest` (default) | The version under the registry's `latest` tag                                     |
| `minor`            | Do not cross the major; latest within the current major                           |
| `patch`            | Patch bumps only                                                                  |
| `semver`           | Only up to the highest version the current range allows (range meaning unchanged) |
| `greatest`         | Highest version number, prereleases included                                      |
| `newest`           | Most recently published version, regardless of number                             |
| `@<tag>`           | A specific dist-tag, e.g. `@next`, `@beta`                                        |

**Updating to a specific version**

- `depseek up react@19.0.0`: set react to 19.0.0 in every project (prefix written according to `--format`).
- `depseek up react@^19`: resolves to the latest version satisfying the range.
- Several at once: `depseek up react@19.0.0 react-dom@19.0.0`.
- Verify the version actually exists on the registry before writing.

**Changing the style without upgrading**

`depseek format --to exact`: only rewrites existing `^1.2.3`, `~1.2.3` to `1.2.3` (or the reverse), keeping the version. Useful for unifying style. When converting to exact, the version actually installed according to the lock file can be used (`--from-lock`) instead of the range's lower bound.

**Special version specs**

| Spec                                       | Default handling                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------ |
| `workspace:*`, `file:`, `link:`, `portal:` | Skipped                                                                  |
| git / GitHub URL, tarball URL              | Skipped, listed as "cannot check"                                        |
| `npm:pkg@x` alias                          | Looked up by the real package name, written back in alias form           |
| `*`, `latest`, `x`                         | Skipped by default; `--pin-wildcards` turns them into concrete versions  |
| `catalog:`                                 | Skipped (with bun workspaces, the catalog itself could be updated later) |
| `overrides` / `resolutions`                | Also checked and updated, but marked separately                          |
| `engines`, `packageManager`                | Optional checks (e.g. the bun version), off by default                   |

## Filtering and selection

All commands (check / conflicts / up) share the same filter flags.

- **By package name**: `-f, --filter <pattern>` only handles matching packages; `-x, --reject <pattern>` excludes. Wildcards (`@types/*`), comma-separated lists and `/regex/` are supported, as in ncu.
- **By dependency type**: `--dep prod,dev,peer,optional,overrides,packageManager`, default `prod,dev,optional,packageManager` (as in ncu; peer is left alone by default since it is a constraint for consumers).
- **By project**: `--project <glob>` only handles package.json files whose path or `name` matches.
- **By level**: `--level patch,minor` only shows/updates those levels, e.g. auto-upgrading only patches day to day.
- **By publish time**: `-c, --cooldown <period>` (`7`, `7d`, `12h`, `30m`) ignores freshly published versions, avoiding versions yanked or poisoned right after release (see Additional features).

**Interactive mode (`-i`)**

- The list is grouped by major / minor / patch; patch and minor are selected by default, major is not.
- Keys: space toggles, `a` selects all, `p` / `m` / `M` select by level, `/` searches.
- A row can be expanded: see the affected projects, pick another version (not necessarily the latest), open the changelog link.
- The same dependency across projects is one row; after expanding, only some projects can be selected.
- Before confirming, show how many files and dependencies will change.

## Additional features

Features that were not requested but are common and useful when managing dependencies across projects, in suggested priority order.

| Feature                         | Problem it solves                                                                                                                                                    | Priority |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| **Install after updating**      | Lock files fall out of sync after package.json changes. `--install always\|prompt\|never`; detect the package manager from each project's lock file, run in parallel | P0       |
| **Related packages together**   | `react`, `react-dom` and `@types/react` must match. Built-in common groups plus a `groups` config (e.g. `@tanstack/*`); a group moves to the same version            | P0       |
| **Undo**                        | An update turns out to break things. Back up every changed package.json before writing; `depseek undo` restores in one step                                          | P0       |
| **Dry run / diff preview**      | See what would change first. `--dry-run` prints a unified diff                                                                                                       | P0       |
| **Version cooldown**            | Supply-chain attacks are often discovered and yanked within hours of release. `--cooldown 3` skips versions published in the last 3 days                             | P1       |
| **Deprecation notices**         | A deprecated package or version is in use without anyone knowing. Show the deprecation message and recommended replacement                                           | P1       |
| **Vulnerability checks**        | Query OSV / GitHub Advisory, flag dependencies whose current version has known vulnerabilities, and suggest "upgrade to X to fix"                                    | P1       |
| **Ignore and pin**              | Some packages are deliberately held back, or a version is known to be buggy. Config `ignore`, `pin`, `ignoreVersions` (e.g. `vite@6.1.0`), with a note on the reason | P1       |
| **Peer dependency pre-check**   | Upgrading A breaks B's peerDependencies. Compute and warn before writing                                                                                             | P1       |
| **Changelog links**             | What did a major upgrade change? Generate GitHub Releases / CHANGELOG links from the repository field; optionally fetch release titles                               | P1       |
| **Doctor mode**                 | Following ncu `--doctor`: upgrade one by one and run the test command, roll back a package on failure, and report which can be upgraded safely                       | P2       |
| **engines compatibility**       | A new version requires a newer Node / Bun. Compare against the local or configured runtime version and warn if incompatible                                          | P2       |
| **@types follow their package** | `@types/node` and similar should match the major of the actual runtime / main package instead of blindly going to latest                                             | P2       |
| **Git integration**             | Require a clean working tree before writing (can be turned off); `--commit` commits per level or group, with the upgraded packages in the message                    | P2       |
| **Report export**               | `--output json\|markdown`; markdown can be pasted straight into a PR description                                                                                     | P2       |
| **License change warnings**     | Warn when a new version changes license (e.g. MIT → BSL); important for commercial projects                                                                          | P2       |
| **Unused dependency detection** | Dependencies in package.json that the code never imports. A lot of work; can come later or delegate to knip                                                          | P3       |
| **Package size changes**        | How much bigger a dependency gets after upgrading. Useful for front-end projects but needs an extra data source                                                      | P3       |

**Update flow** (with the features above combined)

1. Scan files, read config and ignore rules
2. Query the registry concurrently, apply target, cooldown and group rules
3. Check peers, engines, deprecations and vulnerabilities, collecting warnings
4. Show the results (or enter interactive selection)
5. Back up → write package.json according to format, preserving formatting
6. Install in each project as needed, optionally run tests and git commit

## Commands and flags

Keep subcommands few and clear; without a subcommand it behaves as `check`, matching ncu's habits.

**Subcommands**

| Command                         | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `depseek [dir...]` / `check`    | List available updates (read-only)                      |
| `depseek up [pkg[@ver]...]`     | Update, same as `check -u`                              |
| `depseek conflicts`             | List version conflicts; `--fix` aligns them             |
| `depseek format --to <fmt>`     | Change the version style only, no upgrade               |
| `depseek ls [pkg]`              | Which projects use a dependency and at which version    |
| `depseek tree [dir...]`         | List where each package.json lives, as a tree           |
| `depseek doctor [--test <cmd>]` | Upgrade one by one and run tests, rolling back failures |
| `depseek undo`                  | Restore the state before the last write                 |
| `depseek init`                  | Generate a config file template                         |

**Common flags**

| Flag                             | Default                 | Description                     |
| -------------------------------- | ----------------------- | ------------------------------- |
| `--recursive` / `--no-recursive` | Recursive               | Scan recursively or not         |
| `--depth <n>`                    | Unlimited               | Recursion depth                 |
| `--include` / `--exclude <glob>` | —                       | Scan scope                      |
| `-u, --upgrade`                  | Off                     | Write files                     |
| `-t, --target <t>`               | `latest`                | Target version strategy         |
| `--format <f>`                   | `exact`                 | Write style                     |
| `-f, --filter` / `-x, --reject`  | —                       | Filter by package name          |
| `--dep <types>`                  | Includes packageManager | Dependency types                |
| `--level <levels>`               | All                     | Only handle these levels        |
| `-i, --interactive`              | Off                     | Interactive selection           |
| `--group-by <g>`                 | `package`               | package / project / level       |
| `-c, --cooldown <period>`        | 0                       | Cooldown period                 |
| `--install <mode>`               | `prompt`                | Whether to install after update |
| `--dry-run`                      | Off                     | Only show the diff              |
| `--theme <name>`                 | `default`               | Colour theme                    |
| `--output <fmt>`                 | `table`                 | table / json / markdown         |
| `--error-on <cond>`              | —                       | For CI, see below               |
| `--concurrency <n>`              | 16                      | Concurrent registry requests    |
| `--no-cache`                     | —                       | Ignore the local cache          |
| `--config <path>`                | Auto-detected           | Config file to use              |

**Examples**

```bash
depseek                                     # check for updates recursively from the current directory
depseek ~/projects --level patch,minor -u   # upgrade patch and minor only
depseek up react@19.0.0 react-dom@19.0.0    # move every project to a specific version
depseek -i --format caret                   # pick interactively, write as ^x.y.z
depseek conflicts --fix --align highest
depseek format --to exact --from-lock
depseek tree ~/projects                     # list every package.json as a tree
```

## Implementation status

Implementation status as of v0.0.1.

| Scope                                                                                                                                                                 | Status | Notes                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| Scanning (multiple dirs, recursion/depth, default ignores, .gitignore, include/exclude, symlinks, fault tolerance, lock/workspace detection, summary, `--list-files`) | ✅     | The default ignore list can be replaced with the `scan.ignore` config; `--no-default-ignore` turns it off |
| Tree listing (`depseek tree`, `--list-files --tree`)                                                                                                                  | ✅     |                                                                                                           |
| Conflict detection (major/minor/style/dependency type/unmet peer) and `--fix --align`                                                                                 | ✅     | Unmet peers are based on the versions installed in `node_modules`                                         |
| Update check (level colours, 0.x, prerelease, deprecation, changed-part highlight, three groupings, summary)                                                          | ✅     |                                                                                                           |
| Colour themes (default / dark / light / colorblind / mono, custom colours, NO_COLOR / FORCE_COLOR)                                                                    | ✅     |                                                                                                           |
| Version lookup (concurrency, dedup, 10-minute cache, .npmrc / bunfig.toml, private scopes and tokens)                                                                 | ✅     |                                                                                                           |
| Write styles (6, configurable per dependency type) and targets (7)                                                                                                    | ✅     | Complex ranges (`>=1 <2`, `a \|\| b`) are rewritten as `^` under `preserve`                               |
| `up pkg@ver`, version existence check, `format --to` / `--from-lock`                                                                                                  | ✅     | `--from-lock` supports node_modules, package-lock, bun.lock, pnpm-lock, yarn.lock                         |
| Special specs (workspace/file/link/portal/catalog/git/URL/alias/wildcard/overrides/packageManager)                                                                    | ✅     | The `engines` field is not checked as a dependency, only used for compatibility warnings                  |
| Filters (`-f` / `-x` / `--dep` / `--project` / `--level` / `--cooldown`)                                                                                              | ✅     |                                                                                                           |
| Interactive mode                                                                                                                                                      | ✅     |                                                                                                           |
| Auto install, related-package groups, undo, dry-run/diff                                                                                                              | ✅     |                                                                                                           |
| Cooldown, deprecation notices, OSV vulnerability checks, ignore and pin, peer pre-check, changelog links                                                              | ✅     | Changelog only generates links, release titles are not fetched                                            |
| Doctor, engines checks, @types following, git integration, report export, license change warnings                                                                     | ✅     |                                                                                                           |
| Unused dependency detection, package size changes (P3)                                                                                                                | ⏳     | Not implemented; use tools such as knip alongside                                                         |
