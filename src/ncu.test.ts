import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgv } from './args.js';
import { main } from './main.js';
import { applyNcurc, normalizeNcuOptions, parseCooldown, parseSimpleYaml, readNcurc } from './ncu.js';
import { fixture, packument } from './test/helpers.js';

describe('ncu option translation', () => {
  it('parses cooldown durations', () => {
    expect(parseCooldown('7')).toBe(7);
    expect(parseCooldown('7d')).toBe(7);
    expect(parseCooldown('12h')).toBe(0.5);
    expect(parseCooldown('36m')).toBeCloseTo(0.025);
    expect(parseCooldown(3)).toBe(3);
    expect(() => parseCooldown('soon')).toThrow(/7d, 12h, 30m/);
  });

  it('accepts camelCase long options', () => {
    const { opts } = parseArgv(['--errorLevel', '2', '--jsonUpgraded'], {
      'error-level': { type: 'number' },
      'json-upgraded': { type: 'boolean' },
    });
    expect(opts).toEqual({ errorLevel: 2, jsonUpgraded: true });
  });

  it('maps ncu options onto depseek options', () => {
    const o: Record<string, unknown> = {
      errorLevel: 2,
      format: 'group,time',
      removeRange: true,
      workspace: ['@m/web'],
      packageFile: ['package.json', 'apps/*/package.json', '**/package.json'],
      root: false,
      jsonUpgraded: true,
      doctor: true,
      doctorTest: 'bun test',
      cooldown: '12h',
    };
    const r = normalizeNcuOptions(o as never);
    expect(r.command).toBe('doctor');
    expect(o.errorOn).toEqual(['outdated']);
    expect(o.format).toBe('exact'); // display values dropped, then --removeRange
    expect(o.project).toEqual(['@m/web', '.', 'apps/*']);
    expect(o.noRoot).toBe(true);
    expect(o.ncuJson).toBe('upgraded');
    expect(o.output).toBe('json');
    expect(o.install).toBe('never');
    expect(o.test).toBe('bun test');
    expect(o.cooldown).toBe(0.5);
  });

  it('rejects unsupported ncu options with a reason', () => {
    expect(() => normalizeNcuOptions({ stdin: true })).toThrow(/--stdin is not supported: depseek reads/);
    expect(() => normalizeNcuOptions({ interactiveSelect: 'some' })).toThrow(/auto, none, patch, minor or all/);
    expect(() => normalizeNcuOptions({ format: 'time,caret' })).toThrow(/don't mix/);
    expect(() => normalizeNcuOptions({ packageManager: 'deno' })).toThrow(/not supported/);
  });
});

describe('.ncurc', () => {
  it('parses YAML and JSON configs and applies them under CLI flags', () => {
    const dir = mkdtempSync(join(tmpdir(), 'depseek-ncurc-'));
    writeFileSync(
      join(dir, '.ncurc.yml'),
      '# comment\nupgrade: true\nreject:\n  - typescript\n  - "@types/*"\ntarget: minor\ncooldown: 3d\nfilterResults: x\n',
    );
    const rc = readNcurc(join(dir, '.ncurc.yml'));
    expect(rc).toEqual({
      upgrade: true,
      reject: ['typescript', '@types/*'],
      target: 'minor',
      cooldown: '3d',
      filterResults: 'x',
    });
    const opts: Record<string, unknown> = { target: 'patch' };
    const ignored = applyNcurc(opts as never, rc, new Set(['upgrade', 'reject', 'target', 'cooldown']));
    expect(opts).toEqual({ target: 'patch', upgrade: true, reject: ['typescript', '@types/*'], cooldown: '3d' });
    expect(ignored).toEqual(['filterResults (predicate functions are not supported)']);

    writeFileSync(join(dir, '.ncurc.json'), '{ "dep": ["prod"], "x": 1 }');
    expect(readNcurc(join(dir, '.ncurc.json'))).toEqual({ dep: ['prod'], x: 1 });
    expect(parseSimpleYaml('filter: [react, vue]')).toEqual({ filter: ['react', 'vue'] });
  });
});

describe('ncu-compatible CLI', () => {
  const docs: Record<string, object> = {
    react: packument('react', { '18.3.1': {}, '19.0.0': {}, '19.1.0': {} }),
    zod: packument('zod', { '3.22.0': {}, '3.24.0': {} }),
    pnpm: packument('pnpm', { '9.0.0': {}, '9.1.0': {} }),
  };
  let server: Server;
  let registry = '';
  beforeAll(async () => {
    server = createServer((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').slice(1));
      const doc = docs[name];
      res.writeHead(doc ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(doc ?? {}));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    registry = `http://127.0.0.1:${addr.port}/`;
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

  const files = {
    'package.json': {
      name: 'root',
      workspaces: ['web'],
      packageManager: 'pnpm@9.0.0',
      dependencies: { zod: '^3.22.0' },
    },
    'web/package.json': { name: 'web', dependencies: { react: '18.3.1' } },
  };

  it('treats positional names as filters and prints ncu --jsonUpgraded', async () => {
    const root = fixture(files);
    const r = await run(['react', '--jsonUpgraded'], root);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ 'package.json': {}, 'web/package.json': { react: '19.1.0' } });
  });

  it('checks packageManager by default and keeps it exact', async () => {
    const root = fixture(files);
    const r = await run(['--jsonUpgraded', '--packageFile', 'package.json', '--format', 'caret'], root);
    expect(JSON.parse(r.out)).toEqual({ zod: '^3.24.0', pnpm: '9.1.0' });
  });

  it('--minimal skips versions the range already allows; -e 2 fails when outdated', async () => {
    const root = fixture(files);
    const r = await run(['-m', '--jsonUpgraded', '--no-root'], root);
    expect(JSON.parse(r.out)).toEqual({ react: '19.1.0' });
    const m = await run(['-m', '-f', 'zod', '-e', '2', '-s'], root);
    expect(m).toEqual({ code: 0, out: '', err: '' });
    const e = await run(['-f', 'zod', '-e', '2', '-s'], root);
    expect(e).toEqual({ code: 1, out: '', err: '' });
  });

  it('-u --jsonUpgraded writes and prints only JSON; .ncurc options apply', async () => {
    const root = fixture({ ...files, '.ncurc.json': '{ "reject": ["zod", "pnpm"], "target": "minor" }' });
    const r = await run(['-u', '--jsonUpgraded', '--no-git-check'], root);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ 'package.json': {}, 'web/package.json': {} });
    expect(readFileSync(join(root, 'web/package.json'), 'utf8')).toContain('"react": "18.3.1"');
    const all = await run(['-u', '--jsonUpgraded', '--no-git-check', '--target', 'latest'], root);
    expect(JSON.parse(all.out)).toEqual({ 'package.json': {}, 'web/package.json': { react: '19.1.0' } });
    expect(readFileSync(join(root, 'web/package.json'), 'utf8')).toContain('"react": "19.1.0"');
  });
});

describe('exact format hint', () => {
  it('explains when ^ / ~ ranges become exact versions', async () => {
    const { exactFormatHint } = await import('./commands/shared.js');
    const a = {
      updates: [
        { entry: { raw: '^1.0.0' }, newRaw: '1.2.0' },
        { entry: { raw: '1.0.0' }, newRaw: '1.2.0' },
      ],
    };
    const ctx = (opts: object, config: object = {}) => ({ opts, config }) as never;
    expect(exactFormatHint(ctx({}), a as never)).toMatch(/^Note: 1 range \(\^ \/ ~\) will be written as exact/);
    expect(exactFormatHint(ctx({ format: 'exact' }), a as never)).toBeUndefined();
    expect(exactFormatHint(ctx({}, { format: 'exact' }), a as never)).toBeUndefined();
    expect(exactFormatHint(ctx({}), { updates: [a.updates[1]] } as never)).toBeUndefined();
  });
});
