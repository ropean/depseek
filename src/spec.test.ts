import { describe, expect, it } from 'vitest';
import { applyStringEdits } from './jsonEdit.js';
import { overrideKeyName } from './project.js';
import { formatSpec, parseSpec } from './spec.js';
import { nameMatcher, pathMatcher } from './util/glob.js';

describe('parseSpec', () => {
  it.each([
    ['^1.2.3', 'range', '1.2.3'],
    ['~1.2', 'range', '1.2.0'],
    ['1.x', 'range', '1.0.0'],
    ['>=2.0.0 <3', 'range', '2.0.0'],
    ['workspace:*', 'workspace', undefined],
    ['file:../x', 'file', undefined],
    ['github:user/repo', 'git', undefined],
    ['user/repo#main', 'git', undefined],
    ['https://example.com/x.tgz', 'url', undefined],
    ['*', 'wildcard', undefined],
    ['latest', 'wildcard', undefined],
    ['next', 'tag', undefined],
    ['catalog:', 'catalog', undefined],
  ])('%s → %s', (raw, kind, base) => {
    const s = parseSpec(raw);
    expect(s.kind).toBe(kind);
    expect(s.base).toBe(base);
  });

  it('parses npm aliases', () => {
    const s = parseSpec('npm:@scope/real@^2.0.0');
    expect(s).toMatchObject({ kind: 'range', alias: '@scope/real', range: '^2.0.0', prefix: '^' });
  });
});

describe('formatSpec', () => {
  const f = (raw: string, v: string, fmt: Parameters<typeof formatSpec>[2]) => formatSpec(parseSpec(raw), v, fmt);
  it('writes every format', () => {
    expect(f('^1.0.0', '1.4.2', 'exact')).toBe('1.4.2');
    expect(f('^1.0.0', '1.4.2', 'tilde')).toBe('~1.4.2');
    expect(f('1.0.0', '1.4.2', 'caret')).toBe('^1.4.2');
    expect(f('^1.0.0', '1.4.2', 'gte')).toBe('>=1.4.2');
    expect(f('~1.0.0', '1.4.2', 'preserve')).toBe('~1.4.2');
    expect(f('1.x', '2.4.2', 'preserve')).toBe('2.x');
    expect(f('1.2.x', '2.4.2', 'x-range')).toBe('2.4.x');
    expect(f('1.x.x', '2.4.2', 'x-range')).toBe('2.x.x');
    expect(f('^1.0.0', '2.4.2', 'x-range')).toBe('2.4.x');
    expect(f('>=1 <2', '2.4.2', 'preserve')).toBe('^2.4.2');
    expect(f('npm:real@^1.0.0', '1.4.2', 'exact')).toBe('npm:real@1.4.2');
  });
});

describe('applyStringEdits', () => {
  it('keeps formatting byte-for-byte', () => {
    const text = '﻿{\r\n\t"name": "x",\r\n\t"dependencies": {\r\n\t\t"a": "^1.0.0",  "b":"2"\r\n\t}\r\n}';
    const out = applyStringEdits(text, [
      { path: ['dependencies', 'a'], value: '1.2.0' },
      { path: ['dependencies', 'b'], value: '~3.0.0' },
    ]);
    expect(out).toBe('﻿{\r\n\t"name": "x",\r\n\t"dependencies": {\r\n\t\t"a": "1.2.0",  "b":"~3.0.0"\r\n\t}\r\n}');
  });
  it('throws for missing paths', () => {
    expect(() => applyStringEdits('{}', [{ path: ['x'], value: '1' }])).toThrow();
  });
});

describe('matchers', () => {
  it('matches names like ncu', () => {
    const m = nameMatcher('react,@types/*')!;
    expect(m('react')).toBe(true);
    expect(m('@types/node')).toBe(true);
    expect(m('react-dom')).toBe(false);
    expect(nameMatcher('/^eslint/')!('eslint-plugin-x')).toBe(true);
  });
  it('matches paths', () => {
    expect(pathMatcher(['fixtures'])('a/fixtures/b')).toBe(true);
    expect(pathMatcher(['apps/*'])('apps/web')).toBe(true);
    expect(pathMatcher(['apps/*'])('apps/web/x')).toBe(false);
    expect(pathMatcher(['apps/**'])('apps/web/x')).toBe(true);
  });
  it('extracts override key names', () => {
    expect(overrideKeyName('foo')).toBe('foo');
    expect(overrideKeyName('foo@^1')).toBe('foo');
    expect(overrideKeyName('**/@scope/foo')).toBe('@scope/foo');
    expect(overrideKeyName('a>b')).toBe('b');
    expect(overrideKeyName('a/b')).toBe('b');
  });
});
