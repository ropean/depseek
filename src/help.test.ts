import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_HELP, renderHelp } from './help.js';
import { main } from './main.js';

async function run(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  const code = await main(argv);
  vi.restoreAllMocks();
  return { code, out, err };
}

afterEach(() => vi.restoreAllMocks());

describe('help', () => {
  it('-h fits on one screen and lists every command', async () => {
    const { code, out } = await run('-h');
    expect(code).toBe(0);
    expect(out.split('\n').length).toBeLessThanOrEqual(16);
    for (const name of Object.keys(COMMAND_HELP).filter((n) => n !== 'check')) expect(out).toContain(`depseek ${name}`);
    expect(out).toContain('depseek -h --full');
    expect(out.split('\n')[1]).toContain('Short command: ds');
    expect(out).not.toContain('--target');
    expect(out).not.toContain('--allow-major');
  });

  it('`help` with no topic is the same as -h', async () => {
    expect((await run('help')).out).toBe((await run('-h')).out);
  });

  it('-h --full, `help full` and the --all alias print every option', async () => {
    const all = (await run('-h', '--full')).out;
    expect((await run('help', 'full')).out).toBe(all);
    expect((await run('-h', '--all')).out).toBe(all);
    expect((await run('help', 'all')).out).toBe(all);
    for (const o of ['--allow-major', '--from-lock', '--doctor-install', '--follow-symlinks', '--json-upgraded'])
      expect(all).toContain(o);
  });

  it('<command> -h and `help <command>` show only that command', async () => {
    const conflicts = (await run('conflicts', '-h')).out;
    expect((await run('help', 'conflicts')).out).toBe(conflicts);
    expect(conflicts).toContain('Usage: depseek conflicts');
    expect(conflicts).toContain('--align');
    expect(conflicts).not.toContain('--target');
    expect((await run('ls', '--help')).out).not.toContain('--fix');
  });

  it('every command renders', () => {
    for (const name of Object.keys(COMMAND_HELP) as (keyof typeof COMMAND_HELP)[])
      expect(renderHelp('0.0.0', name)).toContain(COMMAND_HELP[name].usage);
  });

  it('`help <unknown>` exits 2', async () => {
    const { code, err } = await run('help', 'nope');
    expect(code).toBe(2);
    expect(err).toContain('unknown command "nope"');
  });

  it('`list` is an alias of `ls`', async () => {
    expect((await run('list', '-h')).out).toBe((await run('ls', '-h')).out);
    expect((await run('help', 'list')).out).toBe((await run('help', 'ls')).out);
  });
});

describe('unknown command hint', () => {
  it('suggests the closest command for a typo', async () => {
    const { suggest } = await import('./util/suggest.js');
    const cmds = ['up', 'conflicts', 'format', 'ls', 'tree', 'undo', 'doctor', 'init'];
    expect(suggest('confilcts', cmds)).toBe('conflicts');
    expect(suggest('lss', cmds)).toBe('ls');
    expect(suggest('react', cmds)).toBeUndefined();
    expect(suggest('hono', cmds)).toBeUndefined();
  });
});
