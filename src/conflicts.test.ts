import { describe, expect, it } from 'vitest';
import { alignTarget, findConflicts, findPeerProblems } from './conflicts.js';
import { scan } from './scan.js';
import { buildSelection, selectEntries } from './select.js';
import { fixture } from './test/helpers.js';

const files = {
  'a/package.json': { name: 'a', dependencies: { react: '^18.3.1', zod: '^3.22.0', ts: '5.6.2', lodash: '4.17.21' } },
  'b/package.json': {
    name: 'b',
    dependencies: { react: '^19.0.0', zod: '^3.24.1' },
    devDependencies: { ts: '~5.6.2', lodash: '4.17.21' },
  },
  'c/package.json': { name: 'c', dependencies: { react: '^19.0.0', zod: '^3.24.1', 'react-dom': '19.0.0' } },
  'c/node_modules/react-dom/package.json': {
    name: 'react-dom',
    version: '19.0.0',
    peerDependencies: { react: '^19.0.0' },
  },
  'c/node_modules/react/package.json': { name: 'react', version: '18.3.1' },
  'legacy/package.json': { name: 'legacy', dependencies: { react: '^16.0.0' } },
};

async function setup() {
  const root = fixture(files);
  const r = await scan({ cwd: root });
  return { r, entries: selectEntries(r.projects, buildSelection({}, {})) };
}

describe('findConflicts', () => {
  it('classifies conflicts and sorts by severity', async () => {
    const { entries } = await setup();
    const cs = findConflicts(entries);
    expect(cs.map((c) => [c.name, c.severity, c.type])).toEqual([
      ['react', 'high', 'major'],
      ['zod', 'medium', 'minor'],
      ['ts', 'low', 'format'],
      ['lodash', 'hint', 'section'],
    ]);
    expect(cs[0]!.variants.map((v) => [v.raw, v.entries.length])).toEqual([
      ['^19.0.0', 2],
      ['^18.3.1', 1],
      ['^16.0.0', 1],
    ]);
  });

  it('respects ignore and project groups', async () => {
    const { entries } = await setup();
    expect(findConflicts(entries, { ignore: ['react', 'zod'] }).map((c) => c.name)).toEqual(['ts', 'lodash']);
    const grouped = findConflicts(entries, { groups: [{ name: 'legacy', projects: ['legacy'] }] });
    expect(grouped.find((c) => c.name === 'react')!.variants).toHaveLength(2);
  });

  it('computes align targets', async () => {
    const { entries } = await setup();
    const react = findConflicts(entries)[0]!;
    expect(alignTarget(react.variants, 'highest')).toBe('19.0.0');
    expect(alignTarget(react.variants, 'lowest')).toBe('16.0.0');
    expect(alignTarget(react.variants, 'most-used')).toBe('19.0.0');
  });

  it('finds unmet peer dependencies from node_modules', async () => {
    const { r, entries } = await setup();
    const peers = findPeerProblems(r.projects, entries);
    expect(peers.map((p) => `${p.pkg}→${p.peer}@${p.range} (${p.installed})`)).toEqual([
      'react-dom→react@^19.0.0 (18.3.1)',
    ]);
  });
});
