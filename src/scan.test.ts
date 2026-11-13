import { describe, expect, it } from 'vitest';
import { scan } from './scan.js';
import { renderTree } from './tree.js';
import { createPainter } from './util/color.js';
import { fixture } from './test/helpers.js';

const files = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.gitignore': 'tmp/\n',
  'package.json': { name: 'mono', private: true, workspaces: ['apps/*'], devDependencies: { typescript: '~5.6.2' } },
  'bun.lock': '{}',
  'apps/web/package.json': {
    name: '@m/web',
    dependencies: { react: '^18.3.1', '@m/api': '^1.0.0', ui: 'workspace:*' },
  },
  'apps/api/package.json': { name: '@m/api', version: '1.0.0', dependencies: { zod: '^3.24.1' } },
  'libs/a/b/c/package.json': { name: 'deep', dependencies: { react: '^19.0.0' } },
  'libs/broken/package.json': '{ "name": ',
  'node_modules/x/package.json': { name: 'x' },
  'fixtures/y/package.json': { name: 'y' },
  'tmp/z/package.json': { name: 'z' },
};

describe('scan', () => {
  it('finds package.json files, skipping defaults, gitignored dirs and broken files', async () => {
    const root = fixture(files);
    const r = await scan({ cwd: root });
    expect(r.projects.map((p) => p.rel)).toEqual([
      'apps/api/package.json',
      'apps/web/package.json',
      'libs/a/b/c/package.json',
      'package.json',
    ]);
    expect(r.broken.map((b) => b.rel)).toEqual(['libs/broken/package.json']);
    expect(r.warnings).toHaveLength(1);
  });

  it('honours --no-gitignore, depth, include, exclude and --no-recursive', async () => {
    const root = fixture(files);
    expect((await scan({ cwd: root, gitignore: false })).projects.some((p) => p.rel === 'tmp/z/package.json')).toBe(
      true,
    );
    expect((await scan({ cwd: root, recursive: false })).projects.map((p) => p.rel)).toEqual(['package.json']);
    expect((await scan({ cwd: root, depth: 2 })).projects).toHaveLength(3);
    expect((await scan({ cwd: root, exclude: ['libs'] })).projects).toHaveLength(3);
    expect((await scan({ cwd: root, include: ['apps/**'] })).projects.map((p) => p.name)).toEqual(['@m/api', '@m/web']);
    expect((await scan({ cwd: root, ignore: [], gitignore: false })).projects.length).toBe(7);
  });

  it('links workspaces, inherits the root lock and marks internal deps', async () => {
    const root = fixture(files);
    const r = await scan({ cwd: root });
    const web = r.projects.find((p) => p.name === '@m/web')!;
    expect(web.workspaceRoot?.name).toBe('mono');
    expect(web.effectiveLock?.pm).toBe('bun');
    expect(web.deps.filter((d) => d.internal).map((d) => d.name)).toEqual(['@m/api', 'ui']);
    expect(r.projects.find((p) => p.name === 'deep')!.workspaceRoot).toBeUndefined();
  });
});

describe('renderTree', () => {
  it('renders a compressed directory tree', async () => {
    const root = fixture(files);
    const r = await scan({ cwd: root });
    const out = renderTree(r, createPainter('mono', {}, false), { cwd: root, details: false });
    expect(out).toBe(
      [
        '. (4 package.json)  mono',
        '├── apps/',
        '│   ├── api  @m/api@1.0.0',
        '│   └── web  @m/web',
        '└── libs/',
        '    ├── a/b/c  deep',
        '    └── broken  ✖ invalid package.json: ' + r.broken[0]!.error,
      ].join('\n'),
    );
  });
});

describe('treeSummary', () => {
  it('counts files, workspace layout, dependencies and locks', async () => {
    const { treeSummary, renderTreeSummary } = await import('./tree.js');
    const r = await scan({ cwd: fixture(files) });
    const s = treeSummary(r);
    expect(s.files).toBe(4);
    expect(s.invalid).toBe(1);
    expect(s.workspaceRoots + s.workspaceMembers + s.standalone).toBe(4);
    expect(s.internal).toBe(2);
    expect(renderTreeSummary(r, createPainter('mono', {}, false))).toMatch(/^Summary\n  package\.json +4 /);
  });
});
