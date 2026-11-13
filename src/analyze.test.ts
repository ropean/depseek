import { describe, expect, it } from 'vitest';
import type { OptValues } from './args.js';
import { analyze } from './analyze.js';
import { RegistryClient } from './registry.js';
import { highlightChange } from './render/common.js';
import { scan } from './scan.js';
import { buildSelection, selectEntries } from './select.js';
import { diffLevel, pickTarget } from './versions.js';
import { fakeFetch, fixture, packument } from './test/helpers.js';

const docs = {
  react: packument('react', { '18.2.0': {}, '18.3.1': {}, '19.0.0': {}, '19.1.0': {}, '19.2.0-rc.1': {} }),
  'react-dom': packument('react-dom', {
    '18.2.0': {},
    '18.3.1': {},
    '19.0.0': { peerDependencies: { react: '^19.0.0' } },
  }),
  zod: packument('zod', { '3.22.0': { license: 'MIT' }, '3.24.1': {}, '3.25.0': { license: 'BSL-1.1' }, '4.0.0': {} }),
  'left-pad': packument('left-pad', {
    '1.0.0': { deprecated: 'use padStart' },
    '1.3.0': { deprecated: 'use padStart' },
  }),
  '@types/react': packument('@types/react', { '18.3.0': {}, '19.0.1': {}, '19.1.2': {}, '20.0.0': {} }),
  fresh: packument('fresh', { '1.0.0': {}, '1.1.0': { time: new Date().toISOString() } }),
};

const client = () =>
  new RegistryClient({
    config: { registry: 'https://r.test/', scopes: {}, auth: [] },
    useCache: false,
    fetch: fakeFetch(docs),
  });

describe('versions', () => {
  it('computes levels with 0.x as breaking', () => {
    expect(diffLevel('1.2.3', '2.0.0').level).toBe('major');
    expect(diffLevel('1.2.3', '1.3.0').level).toBe('minor');
    expect(diffLevel('1.2.3', '1.2.4').level).toBe('patch');
    expect(diffLevel('0.3.0', '0.4.0')).toEqual({ level: 'major', zero: true });
    expect(diffLevel('1.0.0', '2.0.0-rc.1').level).toBe('prerelease');
  });

  it('picks targets per strategy', () => {
    const meta = {
      name: 'x',
      distTags: { latest: '2.1.0', next: '3.0.0-beta.1' },
      time: {
        '1.0.0': '2020-01-01',
        '1.0.5': '2020-02-01',
        '1.4.0': '2020-03-01',
        '2.1.0': '2020-04-01',
        '3.0.0-beta.1': '2020-05-01',
        '1.5.0': '2021-01-01',
      },
      versions: Object.fromEntries(['1.0.0', '1.0.5', '1.4.0', '1.5.0', '2.1.0', '3.0.0-beta.1'].map((v) => [v, {}])),
    };
    expect(pickTarget(meta, '1.0.0', 'latest', '^1.0.0')).toBe('2.1.0');
    expect(pickTarget(meta, '1.0.0', 'minor', '^1.0.0')).toBe('1.5.0');
    expect(pickTarget(meta, '1.0.0', 'patch', '^1.0.0')).toBe('1.0.5');
    expect(pickTarget(meta, '1.0.0', 'semver', '~1.0.0')).toBe('1.0.5');
    expect(pickTarget(meta, '1.0.0', 'greatest', '^1.0.0')).toBe('3.0.0-beta.1');
    expect(pickTarget(meta, '1.0.0', 'newest', '^1.0.0')).toBe('1.5.0');
    expect(pickTarget(meta, '1.0.0', '@next', '^1.0.0')).toBe('3.0.0-beta.1');
    expect(pickTarget(meta, '2.1.0', 'latest', '2.1.0')).toBeUndefined();
    expect(pickTarget(meta, '1.0.0', 'latest', '^1.0.0', { exclude: (v) => v === '2.1.0' })).toBe('1.5.0');
    expect(pickTarget(meta, '1.0.0', 'latest', '^1.0.0', { pin: '~1.4.0' })).toBe('1.4.0');
  });

  it('highlights only the changed part', () => {
    const p = {
      enabled: true,
      style: (_: string, t: string) => t,
      paint: (_r: string, t: string) => `[${t}]`,
    } as never;
    expect(highlightChange(p, '1.2.3', '1.4.0', 'minor')).toBe('1.[4.0]');
    expect(highlightChange(p, '1.2.3', '^2.0.0', 'major')).toBe('^[2.0.0]');
    expect(highlightChange(p, '1.2.3', '1.2.4', 'patch')).toBe('1.2.[4]');
  });
});

describe('analyze', () => {
  const files = {
    'a/package.json': {
      name: 'a',
      dependencies: {
        react: '^18.2.0',
        'react-dom': '^18.2.0',
        zod: '^3.22.0',
        'left-pad': '^1.0.0',
        fresh: '1.0.0',
        gh: 'github:x/y',
      },
      devDependencies: { '@types/react': '^18.3.0' },
    },
    'b/package.json': { name: 'b', dependencies: { react: '19.0.0', zod: '~3.24.1', missing: '^1.0.0' } },
  };

  async function run(extra: Record<string, unknown> = {}, opts: OptValues = {}) {
    const root = fixture(files);
    const r = await scan({ cwd: root });
    const selection = buildSelection(opts, {});
    return analyze(r.projects, selectEntries(r.projects, selection), { client: client(), selection, ...extra });
  }

  it('finds updates, groups react + react-dom and follows @types majors', async () => {
    const a = await run();
    const byKey = Object.fromEntries(a.updates.map((u) => [`${u.entry.project.name}:${u.name}`, u.newRaw]));
    expect(byKey['a:react']).toBe('19.0.0'); // held to react-dom's latest by the group
    expect(byKey['a:react-dom']).toBe('19.0.0');
    expect(byKey['a:@types/react']).toBe('19.0.1');
    expect(byKey['b:react']).toBe('19.1.0');
    expect(byKey['a:zod']).toBe('4.0.0');
    expect(a.errors.get('missing')).toMatch(/not found/);
    expect(a.skipped.find((s) => s.entry.name === 'gh')?.uncheckable).toBe(true);
    expect(a.deprecated.map((d) => d.entry.name)).toEqual(['left-pad']);
  });

  it('applies cooldown, level filters and formats', async () => {
    const a = await run({ cooldown: 3, format: 'caret', target: 'minor' }, { level: 'minor' });
    const names = a.updates.map((u) => `${u.entry.project.name}:${u.name}=${u.newRaw}`);
    expect(names).toContain('a:zod=^3.25.0');
    expect(names.some((n) => n.includes('fresh'))).toBe(false);
    const zod = a.updates.find((u) => u.name === 'zod' && u.entry.project.name === 'a')!;
    expect(zod.warnings.some((w) => w.type === 'license')).toBe(true);
  });

  it('warns about peer dependencies before writing', async () => {
    const a = await run({ explicit: new Map([['react-dom', '19.0.0']]), builtinGroups: false });
    const u = a.updates.find((x) => x.name === 'react-dom')!;
    expect(u.warnings.find((w) => w.type === 'peer')?.message).toMatch(/wants react@\^19\.0\.0/);
  });

  it('brings group members along with an explicit version', async () => {
    const a = await run({ explicit: new Map([['react-dom', '19.0.0']]) });
    const byKey = Object.fromEntries(a.updates.map((u) => [`${u.entry.project.name}:${u.name}`, u]));
    expect(byKey['a:react-dom']?.newRaw).toBe('19.0.0');
    expect(byKey['a:react']?.newRaw).toBe('19.0.0');
    expect(byKey['a:react']?.warnings.some((w) => w.type === 'group')).toBe(true);
    expect(byKey['a:react-dom']?.warnings.some((w) => w.type === 'peer')).toBe(false);
    expect(byKey['b:react']).toBeUndefined(); // no react-dom in b, nothing to align
    expect(a.updates.some((u) => u.name === 'zod')).toBe(false);
  });
});

describe('analyze: runtime-less @types/node and overrides', () => {
  const extraDocs = {
    '@types/node': packument('@types/node', { '24.1.0': {}, '24.1.5': {}, '24.9.0': {}, '26.0.0': {} }),
    hono: packument('hono', { '4.1.0': {}, '4.2.0': {} }),
  };
  const files = {
    'package.json': {
      name: 'root',
      workspaces: ['app'],
      devDependencies: { '@types/node': '24.1.0' },
      overrides: { hono: '4.1.0' },
    },
    'app/package.json': { name: 'app', dependencies: { hono: '4.1.0' } },
  };
  async function run(extra: Record<string, unknown> = {}, opts: OptValues = {}) {
    const root = fixture(files);
    const r = await scan({ cwd: root });
    const selection = buildSelection(opts, {});
    const c = new RegistryClient({
      config: { registry: 'https://r.test/', scopes: {}, auth: [] },
      useCache: false,
      fetch: fakeFetch(extraDocs),
    });
    return analyze(r.projects, selectEntries(r.projects, selection), { client: c, selection, ...extra });
  }

  it('keeps @types/node on its major but lets the minor move', async () => {
    const a = await run();
    const u = a.updates.find((x) => x.name === '@types/node')!;
    expect(u.target).toBe('24.9.0');
    expect(u.warnings.find((w) => w.type === 'types')?.message).toMatch(/held at 24\.x to match the current major/);
  });

  it('follows runtime.node minor when the runtime is known', async () => {
    const a = await run({ runtime: { node: '24.1.3' } });
    expect(a.updates.find((x) => x.name === '@types/node')?.target).toBe('24.1.5');
  });

  it('warns when an override in the workspace root pins the dependency', async () => {
    const a = await run();
    const u = a.updates.find((x) => x.name === 'hono')!;
    expect(u.warnings.find((w) => w.type === 'override')?.message).toMatch(
      /overrides in package\.json pins hono@4\.1\.0/,
    );
    const b = await run({}, { dep: 'prod,dev,overrides' });
    expect(b.updates.find((x) => x.name === 'hono' && x.entry.kind === 'prod')?.warnings).toEqual([]);
  });
});
