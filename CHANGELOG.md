# Changelog

## v0.0.1 - 2026-11-17

### Features

- add the `ds` command as a short alias of depseek
- ncu P1 options — global packages, peer/engines filters, publisher changes
- npm-check-updates compatibility
- print a summary after the tree
- vulnerability audit and doctor mode
- interactive update picker (-i)
- detect and fix version conflicts across projects
- write updates with diff preview, backups, undo and install
- check for updates across all projects
- scan package.json files and list them as a tree

### Fixes

- let github-release `current` create a missing tag
- support npm passkey web auth and drop the clean-tree check
- issues found by running depseek against website-spirit

### Docs

- describe releasing from GitHub Actions
- document installing from GitHub Releases
- add English README, DEVELOPMENT and SPEC
- add CLAUDE.md with English-first language rules
- rename Chinese docs to *.zh-CN.md
- explain the exact-version default, hint when ^ / ~ is dropped
- README, spec with tree view and implementation status

### Chores

- move GitHub releases into github-release.yml and make publish-npm manual
- drop packageManager and devEngines from package.json
- replace prettier with oxfmt
- add a workflow that publishes to GitHub Packages
- rename release workflow to publish-npm and attach the tarball to the GitHub Release
- run only on ci / ci* branches and drop Node 22
- standardise file encoding and line endings across platforms
- expand .gitignore for all platforms, editors and package managers
- pin pnpm 10.33.0, declare pnpm >=10 in devEngines
- publish as @ropean/depseek
- init depseek from npm-package-template, add spec

### Other

- Initial commit
