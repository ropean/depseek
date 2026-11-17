# Development and Release Guide

English | [简体中文](./DEVELOPMENT.zh-CN.md)

> This file is not published to npm (`files` only contains `dist/`); it is for maintainers only.

## 1. Create a new package from this template

```bash
# Option A: click "Use this template" on GitHub (enable "Template repository" in the template repo's Settings), then clone
git clone git@github.com:ropean/<new-repo>.git && cd <new-repo>

# Option B: copy it without the template's git history
pnpm dlx degit ropean/depseek <new-repo> && cd <new-repo> && git init
```

Then run the init script once (renames the package, resets the version and CHANGELOG, optionally removes the CLI, and deletes itself when done):

```bash
node scripts/init.mjs                     # interactive; defaults come from the directory name and git remote
node scripts/init.mjs --name @ropean/foo --description "Does foo" --bin foo --yes
node scripts/init.mjs --name @ropean/foo --no-bin --yes   # library only, no CLI
```

```bash
pnpm install
pnpm run check
```

### Package manager version

- `package.json` deliberately has **no** `packageManager` / `devEngines` field. Use pnpm 10 locally (`pnpm -v`); the lock file format depends on the pnpm major.
- CI pins the major in `pnpm/action-setup` (`version: 10`, in each workflow under `.github/workflows/`). When you move to a new pnpm major, change it there and re-run `pnpm install`.
- **Users are not affected**: installing with `npm`, `pnpm`, `bun` or `npx` is independent of the pnpm used for development.

## 2. Layout

```
src/index.ts          library entry (public API; exported functions declare their return types)
src/cli.ts            CLI entry (optional; delete it + "bin" in package.json for a pure library)
src/*.test.ts         vitest unit tests (not bundled)
tsdown.config.ts      build: library → ESM + CJS + .d.mts/.d.cts; CLI → single ESM file
scripts/check.mjs     one-shot check: lint · typecheck · format · test · build · exports
scripts/smoke.mjs     pack a tarball → install into a temp project → verify import/require/types/bin
scripts/release.mjs   idempotent release: check → publish → CHANGELOG → commit → tag → push
.github/workflows/    ci.yml (pushes to `ci` / `ci*` branches) · github-release.yml (GitHub Release + Packages) · publish-npm.yml (both run manually from Actions)
```

## 3. Common commands

| Command               | Purpose                                                                       |
| --------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`            | tsdown watch mode; rebuilds `dist/` on change                                 |
| `pnpm build`          | Build once                                                                    |
| `pnpm test`           | Run unit tests; `pnpm test:watch` for watch mode                              |
| `pnpm lint`           | oxlint                                                                        |
| `pnpm typecheck`      | `tsc --noEmit`                                                                |
| `pnpm format`         | Format every file with oxfmt                                                  |
| `pnpm check:exports`  | publint + are-the-types-wrong: verify `exports` and type declarations         |
| `pnpm check`          | All of the above, printing PASS/FAIL per step (`--bail` stops at first error) |
| `pnpm smoke`          | Smoke test that simulates a real install (`--keep` keeps the temp project)    |
| `pnpm pack:dry`       | List the files that would be published                                        |
| `pnpm release <bump>` | Release, see section 5                                                        |

## 4. Local testing (using it in another project before publishing)

From "fastest" to "closest to real":

### 4.1 Unit tests

`pnpm test:watch`.

### 4.2 Run the CLI directly

```bash
pnpm build && node dist/cli.mjs --help
```

### 4.3 Global link (easiest for the CLI)

```bash
pnpm build
pnpm link:global          # = pnpm link --global, registers the bin on the global PATH
depseek --help            # available in any directory
pnpm dev                  # keep watch running; the global command picks up changes without relinking
pnpm unlink:global        # remove when done
```

### 4.4 Reference the local source from another project (easiest for the library)

```bash
# in the consuming project:
pnpm add link:../path/to/this-package   # symlink; changes from `pnpm dev` are visible immediately
# or
pnpm add file:../path/to/this-package   # a copy (closer to a real install, but reinstall after changes)
```

Note: `link:` is a symlink, so the consumer resolves this package's own `node_modules`, which occasionally causes
"duplicate instance" problems with things like React; use 4.5 when that happens. Remember to switch the consumer's
dependency back to a normal version when done.

### 4.5 Install from a tarball (closest to the real npm experience)

```bash
pnpm build && pnpm pack                       # produces ropean-xxx-0.1.0.tgz
cd ../consumer && pnpm add ../this-package/ropean-xxx-0.1.0.tgz
```

`pnpm smoke` automates this: pack → `npm install` in a temp directory →
consume it via `import()`, `require()` and TS (NodeNext), and run every `bin --help`.
It catches what unit tests cannot: files missing from `files`, wrong `exports`, a broken bin path / shebang,
runtime dependencies put in devDependencies, and so on. **The release script runs it automatically.**

## 5. Publishing to npm

### 5.1 One-time setup before the first release

1. `npm view <package-name>` returning 404 means the name is free; scoped packages (`@ropean/xxx`) never clash with others.
2. `npm login`, then confirm the account with `npm whoami`; enabling 2FA is recommended (you will be asked for an OTP when publishing).
3. Fill in `description` and `keywords` in `package.json`; `README.md` is the npm page.
4. Check the publish list with `pnpm pack:dry`: it should contain only `dist/`, `README.md`, `LICENSE` and `package.json`.

### 5.2 Local release (default)

A new package starts at `0.0.1`; **release the first version without arguments** to publish 0.0.1 as is:

```bash
pnpm release              # first release v0.0.1 (CI flavour: pnpm release --ci)
```

Every release after that:

```bash
pnpm release patch        # 0.1.0 → 0.1.1
pnpm release minor        # 0.1.1 → 0.2.0
pnpm release major
pnpm release 1.0.0        # explicit version
pnpm release:beta         # 0.2.0 → 0.2.1-beta.0, published under dist-tag "beta", latest untouched
pnpm release prerelease --preid=rc
```

Script flow: preflight → bump version → `pnpm check` → `smoke` → `publish --dry-run` to show the contents → confirm →
publish → generate CHANGELOG from conventional commits → commit `chore: release vX.Y.Z` → tag → push branch and tag.

Common flags: `--yes` skips confirmation, `--otp=123456` passes the 2FA code, `--tag=next` sets the dist-tag,
`--no-smoke` skips the smoke test, `--no-verify` skips git hooks.

### 5.3 When a release fails

**Core principle: publish is the only irreversible step.** So the script moves every check that "could fail after publish"
to **before** publish; anything that still fails after publish is just git bookkeeping, and rerunning after the fix is enough.

Three commands that are always safe to run:

```bash
pnpm release --status     # where the current version stands: npm / CHANGELOG / commit / local tag / remote tag
pnpm release              # no arguments = resume where it stopped (never republishes, never duplicates commits/tags)
pnpm release --abort      # abandon a version that is NOT yet published: restore package.json/CHANGELOG, delete unpublished tags
```

On failure the script prints the failed step, the reason, the suggested next step, and **whether the package is already on npm**.

#### Failures before publish (nothing irreversible has happened)

| Scenario                                                         | What the script does / what you do                                                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Uncommitted changes in the working tree                          | Preflight refuses. Commit or stash, then rerun                                                                                   |
| Local branch is behind the remote                                | Preflight refuses (the push after publish would be rejected otherwise). `git pull --rebase`, then rerun                          |
| No push permission / stale git credentials / remote unreachable  | Preflight detects it early with `git push --dry-run` and `git fetch`                                                             |
| git user.name / email not configured                             | Preflight refuses (the commit after publish would fail otherwise)                                                                |
| Not logged in to npm / token expired                             | Preflight `npm whoami` refuses. `npm login`, then rerun                                                                          |
| Registry unreachable (offline, proxy, npm outage)                | Preflight `npm ping` refuses; if querying npm fails, it **errors out** instead of assuming "not published" and publishing twice  |
| A global mirror is configured (e.g. npmmirror)                   | Every npm query and publish passes `publishConfig.registry` explicitly, unaffected by global mirrors                             |
| Typo in the version argument (`pnpm release pathc`)              | `npm version` errors out, the version is unchanged                                                                               |
| lint / types / tests / build / exports fail                      | The version is bumped but not committed. Fix the code, commit the fix, rerun without arguments; or `--abort` to drop the version |
| Smoke test fails (missing files, broken bin, …)                  | Same as above                                                                                                                    |
| Answered n at the confirmation / pressed Ctrl+C                  | Shows "Interrupted during: …"; rerun to resume or `--abort`                                                                      |
| The remote already has the tag but npm does not have the version | Refuses to publish (CI may be publishing / may have failed / someone else's release). Check `--status`, see 5.4                  |

#### publish itself fails

The script recognises npm's error types and handles each:

| npm error                                                          | Handling                                                                                                                                                                    |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2FA code required (EOTP)                                           | Prompts for the OTP in the terminal and retries; in non-interactive environments it suggests rerunning with `--otp=`                                                        |
| Timeout / connection reset / 429 / 5xx                             | **First checks whether npm actually accepted it** (the request may have arrived); only if not, retries with exponential backoff, up to 4 times                              |
| "cannot publish over previously published"                         | Waits for the CDN and checks again: found = treated as success; not found = this version was unpublished before and can never be reused; `--abort` and pick another version |
| E401 / session expired                                             | Suggests `npm login`, then rerun                                                                                                                                            |
| E403 forbidden                                                     | Lists the usual causes: not a maintainer of the package/org, the account requires 2FA but the token does not support it, the version was unpublished before                 |
| E404 scope not found                                               | Explains that the scope must be your own npm username or org name                                                                                                           |
| E402 / name too similar to an existing package / package too large | A specific hint for each                                                                                                                                                    |

#### Failures after publish (the package is already on npm)

The script prints a prominent **`IS ALREADY ON NPM … Do not bump again`**. Do **not** bump the version again; fix the problem and run
`pnpm release` (no arguments): it skips publish and only completes CHANGELOG / commit / tag / push.

| Scenario                                             | Handling                                                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| git commit rejected by a hook (husky, commit-msg, …) | Fix the hook problem, or `pnpm release --no-verify`                                                              |
| Push rejected: someone just pushed new commits       | `git pull --rebase`, then `pnpm release`; the tag moves to the rebased release commit automatically              |
| Push rejected: protected branch (GH006)              | `pnpm release --tag-only` pushes only the tag; merge the release commit through a PR                             |
| The remote tag points to a different commit          | **Never force-pushes** by default and asks you to check; use `--force-tag` only once you are sure yours is right |
| `npm view` cannot see it right after publish         | Normal CDN delay; the script polls and waits, and it does not block later steps either way                       |
| `--abort` on a published version                     | Refused, with a pointer to `npm deprecate` / `npm dist-tag` (see 5.5)                                            |

#### Other

- **Abandoning a version whose release commit was already pushed**: `--abort` never rewrites pushed history, it only deletes unpublished tags;
  next time use `pnpm release patch --force-bump` to skip that version number.
- **Two people releasing the same version at once**: whoever is second stops at "remote tag exists" or "version already on npm"; nothing is overwritten.

### 5.4 Releasing from GitHub Actions (no local commands)

There are two independent channels, each its own workflow, run from GitHub → Actions → the workflow → **Run workflow**.

| Workflow                           | Input                                            | What it does                                                                                                                                                                                                            |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-release.yml`               | `version`: `patch\|minor\|major\|x.y.z\|current` | Job 1: bumps `package.json`, updates CHANGELOG, commits, tags, pushes, packs the tarball and creates the GitHub Release (`depseek.tgz` + versioned `.tgz`). Job 2: publishes that tag to GitHub Packages. Run on `main` |
| `publish-npm.yml` (unused for now) | `tag`: an existing tag, e.g. `v0.0.1`            | Publishes that tag to npm with provenance; skipped if the version is already on npm                                                                                                                                     |

You never need `git tag` or `pnpm release --ci` locally: run **GitHub Release** and both the tag, the Release and the
GitHub Packages publish happen in that one run. (A tag created by Actions does not trigger other workflows — a GitHub
rule for `GITHUB_TOKEN` — which is why GitHub Packages is a second job of the same workflow instead of a separate one.)

Notes:

- The first release (no tags yet) is released at the current `package.json` version, whatever `version` you enter.
- `version = current` releases the version already in `package.json`: its tag is created first if missing (use this for the first release), otherwise only the Release and the GitHub Packages publish are redone.
- The release commit is pushed to `main` by `github-actions[bot]`; if `main` is protected, allow that push.
- GitHub Packages uses the built-in `GITHUB_TOKEN` (no secret), and the package scope must equal the repository owner (`@ropean`).
  Installing from it needs a GitHub token with `read:packages`, even for public packages.
- Users install from the Release with `npm i -g https://github.com/ropean/depseek/releases/latest/download/depseek.tgz`.
- npm authentication (for `publish-npm.yml`), pick one: **Trusted Publishing** (npmjs.com → package → Settings → Trusted Publisher →
  GitHub Actions, repository name and `publish-npm.yml`; the package must already exist, so the first npm publish is done once locally)
  or a granular token stored as the repository secret `NPM_TOKEN`.
- Each workflow holds a concurrency lock where needed, and a failed job can simply be re-run (an existing version is skipped).

### 5.5 A published version is broken

```bash
npm deprecate @ropean/xxx@1.2.3 "broken, use 1.2.4"        # recommended: mark as deprecated
npm dist-tag add @ropean/xxx@1.2.2 latest                   # point latest back to an older version
npm unpublish @ropean/xxx@1.2.3                             # only within 72 hours and with no dependents; the version can never be reused
```

Then simply release a new version with `pnpm release patch`.

## 6. Conventions

- **Language**: English is the default for code, comments, commit messages and docs. Chinese translations of docs live next to the
  English file with a `.zh-CN.md` suffix (see [CLAUDE.md](./CLAUDE.md)).
- **Files**: UTF-8 without BOM, LF line endings (CRLF only for `.bat` / `.cmd`), enforced by `.editorconfig`,
  `.gitattributes` and oxfmt (`endOfLine: "lf"`) on every platform.
- **Commit messages** follow conventional commits (`feat:`, `fix:`, `perf:`, `refactor:`, `docs:`,
  `chore:`; add `!` for breaking changes, e.g. `feat!: drop node 20`); the CHANGELOG is grouped accordingly.
- **Versioning**: during `0.x` a minor may contain breaking changes; strict semver once stable.
- **Dependencies**:
  - `dependencies`: needed at runtime; tsdown does **not** bundle them (the consumer installs them).
  - `peerDependencies`: provided by the consumer (e.g. react, hono), not bundled either; add `peerDependenciesMeta` for optional ones.
  - `devDependencies`: only used for development/build; if the source imports one, tsdown **bundles** it into `dist`.
  - `.npmrc` sets `save-exact=true`, so new dependencies are pinned to exact versions by default.
- **Node version**: `engines.node` is `>=22` and the build target is `node22`; change all of these together:
  `package.json` engines, the `tsdown.config.ts` target, the `ci.yml` matrix (and the `@types/node` major).

## 7. Common customisations

- **ESM only**: set `format: ['esm']` in the library config of `tsdown.config.ts`; in `package.json` remove `main` and
  `exports["."].require`, and change `types` to `./dist/index.d.mts`.
- **Library only, no CLI**: delete `src/cli.ts` and `bin` in `package.json` (the build config skips it automatically).
- **CLI only, no exported API**: delete `exports`/`main`/`module`/`types`; keep `src/index.ts` as an internal module.
- **Subpath exports** (e.g. `@ropean/xxx/utils`): add `src/utils.ts` to the tsdown `entry`, and add to `exports`:
  ```json
  "./utils": { "import": "./dist/utils.mjs", "require": "./dist/utils.cjs" }
  ```
  then verify with `pnpm check:exports`.
- **Browser / edge runtimes**: set `platform` to `'neutral'` or `'browser'` and avoid `node:*` modules.
- **monorepo**: `release.mjs` supports `--dir=packages/core` or `"release": { "dir": "packages/core" }` in the root `package.json`.
