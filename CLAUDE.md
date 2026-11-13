# CLAUDE.md

Guidance for Claude Code (and other contributors) working in this repository.

## Language

- **English is the default language of this project.** Code, identifiers, comments, JSDoc, log/error messages,
  CLI output, tests, commit messages, PR descriptions and docs are all written in English.
- Chinese translations of docs are optional and live next to the English file with a `.zh-CN.md` suffix
  (`README.md` → `README.zh-CN.md`, `docs/SPEC.md` → `docs/SPEC.zh-CN.md`). The English file is the source of truth.
- Every doc that has a translation starts with a language switcher right below the title:
  `English | [简体中文](./README.zh-CN.md)` in the English file, `[English](./README.md) | 简体中文` in the Chinese one.
- When linking to a doc that has a Chinese version, link the English file and add the Chinese one next to it,
  e.g. `[docs/SPEC.md](./docs/SPEC.md) ([简体中文](./docs/SPEC.zh-CN.md))`. Chinese docs link to the `.zh-CN.md`
  siblings first, with the English file in parentheses.
- When you change an English doc that has a translation, update the `.zh-CN.md` file in the same change
  (or note in the PR that the translation is behind).

## Files and encoding

- UTF-8 without BOM, LF line endings (CRLF only for `.bat` / `.cmd`), final newline, 2-space indentation —
  see `.editorconfig`, `.gitattributes` and `.prettierrc.json` (`endOfLine: "lf"`).
  Do not commit CRLF files, even on Windows; `.gitattributes` normalises them on commit.
- Run `pnpm format` (Prettier) before committing; `pnpm run check` must pass.

## Project

- `@ropean/depseek`: a CLI (`depseek` / `ds`) plus a library. TypeScript, ESM source, built with tsdown to ESM + CJS.
- Node.js ≥ 22, pnpm (version pinned in `packageManager`).
- Key commands: `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm format`, `pnpm run check`, `pnpm smoke`.
- Conventions (commits, versioning, dependencies, releases): see [DEVELOPMENT.md](./DEVELOPMENT.md)
  ([简体中文](./DEVELOPMENT.zh-CN.md)). Requirements: [docs/SPEC.md](./docs/SPEC.md) ([简体中文](./docs/SPEC.zh-CN.md)).
