import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Update } from './analyze.js';
import { globalInstallCommand, globalProject, parseLsJson } from './commands/global.js';
import { preselected } from './interactive.js';
import { main } from './main.js';
import { fixture, packument } from './test/helpers.js';

const docs: Record<string, object> = {
  host: packument('host', { '1.0.0': {}, '2.0.0': {} }),
  plugin: packument('plugin', {
    '1.0.0': { peerDependencies: { host: '^1.0.0' } },
    '1.5.0': { peerDependencies: { host: '^1.0.0' } },
    '2.0.0': { peerDependencies: { host: '^2.0.0' } },
  }),
  eng: packument('eng', {
    '0.9.0': {},
    '1.0.0': { engines: { node: '>=18' } },
    '2.0.0': { engines: { node: '>=22' } },
  }),
  pr: packument('pr', { '0.9.0': {}, '1.0.0': {}, '1.1.0-beta.1': {} }),
  owned: packument('owned', {
    '1.0.0': { _npmUser: { name: 'alice' } },
    '1.1.0': { _npmUser: { name: 'alice' } },
    '1.2.0': { _npmUser: { name: 'mallory' } },
  }),
  node: packument('node', { '20.0.0': {}, '22.0.0': {} }),
};

let server: Server;
let registry = '';
beforeAll(async () => {
  server = createServer((req, res) => {
    const doc = docs[decodeURIComponent((req.url ?? '/').slice(1))];
    res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(doc ?? {}));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  registry = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
});
afterAll(() => server.close());
beforeEach(() => {
  process.env.DEPSEEK_CACHE_DIR = mkdtempSync(join(tmpdir(), 'depseek-cache-'));
});

async function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  try {
    const code = await main([...args, '--cwd', cwd, '--registry', registry, '--no-cache', '--theme', 'mono']);
    return { code, out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}
const json = async (args: string[], cwd: string): Promise<unknown> => JSON.parse((await run(args, cwd)).out);

describe('ncu P1 options', () => {
  it('--peer keeps a plugin on the host it supports, and moves both together when it can', async () => {
    const root = fixture({ 'package.json': { name: 'a', dependencies: { host: '1.0.0', plugin: '1.0.0' } } });
    expect(await json(['plugin', '--jsonUpgraded'], root)).toEqual({ plugin: '2.0.0' });
    expect(await json(['plugin', '--peer', '--jsonUpgraded'], root)).toEqual({ plugin: '1.5.0' });
    expect(await json(['--peer', '--jsonUpgraded'], root)).toEqual({ host: '2.0.0', plugin: '2.0.0' });
  });

  it('--enginesNode only picks versions whose engines.node covers the project', async () => {
    const root = fixture({ 'package.json': { name: 'a', engines: { node: '>=20' }, dependencies: { eng: '0.9.0' } } });
    expect(await json(['--jsonUpgraded'], root)).toEqual({ eng: '2.0.0' });
    expect(await json(['--enginesNode', '--jsonUpgraded'], root)).toEqual({ eng: '1.0.0' });
  });

  it('--pre includes prereleases; --filterVersion / --rejectVersion match the written version', async () => {
    const root = fixture({ 'package.json': { name: 'a', dependencies: { pr: '0.9.0', eng: '^0.9.0' } } });
    expect(await json(['pr', '--jsonUpgraded'], root)).toEqual({ pr: '1.0.0' });
    expect(await json(['pr', '--pre', '1', '--jsonUpgraded'], root)).toEqual({ pr: '1.1.0-beta.1' });
    expect(await json(['--filterVersion', '^0.9.0', '--jsonUpgraded'], root)).toEqual({ eng: '2.0.0' });
    expect(await json(['--rejectVersion', '/^\\^/', '--jsonUpgraded'], root)).toEqual({ pr: '1.0.0' });
  });

  it('--owner-changed flags a new publisher and --error-on owner fails', async () => {
    const root = fixture({ 'package.json': { name: 'a', dependencies: { owned: '1.0.0' } } });
    const r = await run(['--format', 'ownerChanged', '--error-on', 'owner'], root);
    expect(r.out).toContain('1.2.0 published by mallory, 1.0.0 by alice — first release by this account');
    expect(r.code).toBe(1);
    expect((await run([], root)).out).not.toContain('mallory');
  });

  it('checks devEngines with --dep devEngines and keeps the range style', async () => {
    const root = fixture({
      'package.json': { name: 'a', devEngines: { runtime: [{ name: 'node', version: '>=20.0.0' }] } },
    });
    expect(await json(['--jsonUpgraded'], root)).toEqual({});
    expect(await json(['--dep', 'devEngines', '--jsonUpgraded'], root)).toEqual({ node: '>=22.0.0' });
    await run(['--dep', 'devEngines', '-u', '--no-git-check', '--install', 'never'], root);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).devEngines.runtime[0].version).toBe('>=22.0.0');
  });
});

describe('interactive preselection', () => {
  const u = (level: string, zero = false) => ({ level, zero }) as unknown as Update;
  it('follows --interactiveSelect', () => {
    expect([u('patch'), u('minor'), u('major'), u('minor', true)].map((x) => preselected(x))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(preselected(u('minor'), 'patch')).toBe(false);
    expect(preselected(u('major'), 'all')).toBe(true);
    expect(preselected(u('patch'), 'none')).toBe(false);
  });
});

describe('global packages', () => {
  it('reads npm / pnpm ls output, skipping linked packages', () => {
    const npm = JSON.stringify({
      dependencies: { a: { version: '1.0.0' }, b: { version: '2.0.0', resolved: 'file:../b' } },
    });
    expect(parseLsJson(npm)).toEqual({ deps: { a: '1.0.0' }, linked: ['b'] });
    const pnpm = JSON.stringify([{ path: '/g', dependencies: { c: { version: '3.0.0' } } }]);
    expect(parseLsJson(pnpm)).toEqual({ deps: { c: '3.0.0' }, linked: [] });
    expect(parseLsJson(JSON.stringify([{ path: '/g' }]))).toEqual({ deps: {}, linked: [] });
  });

  it('builds a virtual project and the install command', () => {
    const p = globalProject('pnpm', { a: '1.0.0' });
    expect(p.relDir).toBe('global (pnpm)');
    expect(p.deps.map((d) => [d.name, d.raw, d.kind])).toEqual([['a', '1.0.0', 'prod']]);
    expect(globalInstallCommand('npm', ['a@2'])).toEqual(['npm', ['install', '-g', 'a@2']]);
    expect(globalInstallCommand('yarn', ['a@2'])).toEqual(['yarn', ['global', 'add', 'a@2']]);
    expect(globalInstallCommand('bun', ['a@2'])).toEqual(['bun', ['add', '-g', 'a@2']]);
  });
});
