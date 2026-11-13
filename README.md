# depseek

Scan every package.json under a directory, find cross-project version conflicts and outdated deps, and update them in one go.

[![npm](https://img.shields.io/npm/v/depseek.svg)](https://www.npmjs.com/package/depseek)
[![CI](https://github.com/ropean/depseek/actions/workflows/ci.yml/badge.svg)](https://github.com/ropean/depseek/actions/workflows/ci.yml)

## Install

```sh
pnpm add depseek
```

## Usage

```ts
import { greet } from 'depseek';

greet('world'); // "Hello, world!"
greet('world', { loud: true }); // "HELLO, WORLD!"
```

Works with both `import` (ESM) and `require` (CommonJS); TypeScript types are included.


## CLI

```sh
npx depseek --help
# or install globally
pnpm add -g depseek
depseek world --loud
```


## Development

See [DEVELOPMENT.md](./DEVELOPMENT.md).

## License

MIT
