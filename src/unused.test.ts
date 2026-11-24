import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './main.js';
import { scan } from './scan.js';
import { fixture } from './test/helpers.js';
import { findUnused, importedPackages, mentions, packageOfSpecifier, styleImports, typesTarget } from './unused.js';

describe('specifiers', () => {
  it('maps specifiers to package names and skips relative paths and builtins', () => {
    expect(packageOfSpecifier('lodash/fp')).toBe('lodash');
    expect(packageOfSpecifier('@scope/pkg/sub/path')).toBe('@scope/pkg');
    for (const s of ['./a', '../b', '/abs', '#internal', 'node:fs', 'fs', 'fs/promises', 'virtual:x', '@scope'])
      expect(packageOfSpecifier(s)).toBeUndefined();
  });

  it('finds import, export-from, dynamic import, require and reference forms', () => {
    const src = `
      import a from 'a';
      import type { T } from "b/sub";
      import {
        x,
        y,
      } from '@c/d';
      import 'e';
      export * from 'f';
      const g = await import('g');
      const h = require('h'), i = require.resolve('i');
      vi.mock('j');
      /// <reference types="k" />
      import local from './local';
      import fs from 'node:fs';
    `;
    expect([...importedPackages(src)].sort()).toEqual(['@c/d', 'a', 'b', 'e', 'f', 'g', 'h', 'i', 'j', 'k']);
  });

  it('styleImports reads @import/@use/@plugin and ignores relative paths', () => {
    expect(
      [...styleImports('@import "./a.css"; @import url("lib/x.css"); @use "@s/p"; @forward \'~q/z\';')].sort(),
    ).toEqual(['@s/p', 'lib', 'q']);
  });

  it('mentions matches whole tokens only; typesTarget maps @types names', () => {
    expect(mentions('vitest run', 'vite')).toBe(false);
    expect(mentions('vite build && tsc', 'vite')).toBe(true);
    expect(mentions('extends: "@scope/preset"', '@scope/preset')).toBe(true);
    expect(typesTarget('@types/react')).toBe('react');
    expect(typesTarget('@types/babel__core')).toBe('@babel/core');
    expect(typesTarget('react')).toBeUndefined();
  });
});

const files = {
  'package.json': {
    name: 'app',
    scripts: { build: 'tsdown', test: 'vitest run' },
    dependencies: { react: '^19.0.0', lodash: '^4.17.21', left: '^1.0.0' },
    devDependencies: {
      tsdown: '^0.1.0',
      vitest: '^3.0.0',
      '@types/react': '^19.0.0',
      '@types/lodash': '^4.0.0',
      '@types/node': '^22.0.0',
      'eslint-plugin-x': '^1.0.0',
      unusedtool: '^1.0.0',
    },
    peerDependencies: { 'peer-only': '^1.0.0' },
  },
  'eslint.config.js': "export default [{ plugins: { x: 'eslint-plugin-x' } }];\n",
  'src/index.ts': "import React from 'react';\nimport { sum } from './util';\nexport { React, sum };\n",
  'src/util.ts': "import fs from 'node:fs';\nexport const sum = fs ? 1 : 0;\n",
  'node_modules/lodash/index.js': "require('left');\n",
  'packages/inner/package.json': { name: 'inner', dependencies: { zod: '^3.0.0' } },
  'packages/inner/src/a.ts': "import 'left';\nimport 'lodash';\n",
  'dist/out.js': "require('unusedtool');\n",
};

describe('findUnused', () => {
  it('reports dependencies nothing refers to', async () => {
    const root = fixture(files);
    const r = await scan({ cwd: root, recursive: false });
    const res = await findUnused(r.projects[0]!);
    expect(res.unused.map((u) => [u.entry.name, u.reason])).toEqual([
      ['@types/lodash', 'types-of-unused'],
      ['left', 'not-imported'],
      ['lodash', 'not-imported'],
      ['unusedtool', 'not-imported'],
    ]);
  });

  it('counts scripts, tool config and imports; skips nested packages, peers and node_modules', async () => {
    const root = fixture(files);
    const r = await scan({ cwd: root });
    const outer = r.projects.find((p) => p.name === 'app')!;
    const names = (await findUnused(outer)).unused.map((u) => u.entry.name);
    expect(names).not.toContain('react');
    expect(names).not.toContain('tsdown');
    expect(names).not.toContain('vitest');
    expect(names).not.toContain('eslint-plugin-x');
    expect(names).not.toContain('@types/node');
    expect(names).not.toContain('peer-only');
    expect(names).toContain('left'); // inner/ and node_modules/ imports don't count
    const inner = await findUnused(r.projects.find((p) => p.name === 'inner')!);
    expect(inner.unused.map((u) => u.entry.name)).toEqual(['zod']);
  });

  it('ignores lock files and non-CI yaml but reads CI workflows', async () => {
    const root = fixture({
      'package.json': { name: 'a', dependencies: { locked: '1.0.0', 'ci-tool': '1.0.0', 'yaml-only': '1.0.0' } },
      'pnpm-lock.yaml': 'packages:\n  locked@1.0.0: {}\n  yaml-only@1.0.0: {}\n',
      'bun.lock': '{ "locked": 1 }',
      'package-lock.json': '{ "packages": { "node_modules/locked": {} } }',
      'docs/notes.yaml': 'yaml-only: true\n',
      'CLAUDE.md': 'we use locked and yaml-only and ci-tool\n',
      '.github/workflows/ci.yml': 'steps:\n  - run: npx ci-tool\n',
    });
    const r = await scan({ cwd: root, recursive: false });
    const res = await findUnused(r.projects[0]!);
    expect(res.unused.map((u) => u.entry.name)).toEqual(['locked', 'yaml-only']);
  });

  it('reads stylesheet imports and toml config', async () => {
    const root = fixture({
      'package.json': {
        name: 'a',
        dependencies: {
          '@fontsource/inter': '1',
          'sass-lib': '1',
          'tw-plugin': '1',
          wrangler: '1',
          'css-comment': '1',
        },
      },
      'src/app.css': '@import \'@fontsource/inter/400.css\';\n@plugin "tw-plugin";\n/* css-comment */\n',
      'src/a.scss': '@use "~sass-lib/mixins";\n',
      'wrangler.toml': 'name = "x"\n# managed by wrangler\n',
    });
    const r = await scan({ cwd: root, recursive: false });
    const res = await findUnused(r.projects[0]!);
    expect(res.unused.map((u) => u.entry.name)).toEqual(['css-comment']);
  });

  it('marks candidates that are only mentioned in comments or docs', async () => {
    const root = fixture({
      'package.json': { name: 'a', dependencies: { ghost: '1', 'in-comment': '1', 'in-readme': '1', 'in-text': '1' } },
      'src/a.ts': '// we deliberately do not import in-comment here\nexport const a = 1;\n',
      'README.md': 'Uses in-readme at runtime.\n',
      'notes.txt': 'in-text is injected\n',
      'pnpm-lock.yaml': 'ghost@1: {}\n',
    });
    const r = await scan({ cwd: root, recursive: false });
    const res = await findUnused(r.projects[0]!);
    expect(res.unused.map((u) => [u.entry.name, u.mentioned])).toEqual([
      ['ghost', false],
      ['in-comment', true],
      ['in-readme', true],
      ['in-text', true],
    ]);
  });

  it('honours ignore', async () => {
    const r = await scan({ cwd: fixture(files), recursive: false });
    const res = await findUnused(r.projects[0]!, { ignore: (n) => n === 'left' || n === 'lodash' });
    expect(res.unused.map((u) => u.entry.name)).toEqual(['unusedtool']);
  });
});

describe('depseek unused', () => {
  afterEach(() => vi.restoreAllMocks());
  async function run(...argv: string[]): Promise<{ code: number; out: string }> {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const code = await main(argv);
    vi.restoreAllMocks();
    return { code, out };
  }

  it('exits 1 and lists unused dependencies; --output json is machine readable', async () => {
    const root = fixture(files);
    const text = await run('unused', '--cwd', root, '--no-recursive', '--theme', 'mono');
    expect(text.code).toBe(1);
    expect(text.out).toContain('unusedtool');
    expect(text.out).toContain('Not referenced anywhere');
    const json = await run('unused', '--cwd', root, '--no-recursive', '-o', 'json');
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)[0].unused.map((u: { name: string }) => u.name)).toContain('left');
  });

  it('filters by package, honours config unused.ignore and exits 0 when clean', async () => {
    const root = fixture({
      ...files,
      'depseek.config.json': '{ "unused": { "ignore": ["left", "lodash", "unusedtool"] } }',
    });
    const r = await run('unused', '--cwd', root, '--no-recursive');
    expect(r.code).toBe(0);
    expect(r.out).toContain('No unused dependencies');
    const only = await run('unused', 'left', '--cwd', fixture(files), '--no-recursive', '-o', 'json');
    expect(JSON.parse(only.out)[0].unused.map((u: { name: string }) => u.name)).toEqual(['left']);
  });
});
