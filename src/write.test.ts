import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { scan } from './scan.js';
import { createPainter } from './util/color.js';
import { listBackups, planFileChanges, undo, unifiedDiff, writeWithBackup } from './write.js';
import { fixture } from './test/helpers.js';

beforeEach(() => {
  process.env.DEPSEEK_CACHE_DIR = mkdtempSync(join(tmpdir(), 'depseek-cache-'));
});

const text = '{\n  "name": "a",\n  "dependencies": {\n    "react": "^18.3.1",\n    "zod": "^3.22.0"\n  }\n}\n';

describe('write pipeline', () => {
  it('plans, diffs, writes with backup and undoes', async () => {
    const root = fixture({ 'package.json': text });
    const { projects } = await scan({ cwd: root });
    const p = projects[0]!;
    const react = p.deps.find((d) => d.name === 'react')!;
    const files = planFileChanges([{ entry: react, newRaw: '19.0.0' }]);
    expect(files[0]!.after).toBe(text.replace('^18.3.1', '19.0.0'));

    const diff = unifiedDiff('package.json', files[0]!.before, files[0]!.after, createPainter('mono', {}, false));
    expect(diff).toContain('-    "react": "^18.3.1",\n+    "react": "19.0.0",');
    expect(diff).toContain('@@ -2,5 +2,5 @@');

    writeWithBackup(files, { cwd: root, command: 'up' });
    expect(readFileSync(p.file, 'utf8')).toContain('"react": "19.0.0"');
    expect(listBackups()).toHaveLength(1);

    const r = undo()!;
    expect(r.restored).toEqual([p.file]);
    expect(readFileSync(p.file, 'utf8')).toBe(text);
    expect(undo()).toBeUndefined();
  });

  it('refuses to undo over later edits unless forced', async () => {
    const root = fixture({ 'package.json': text });
    const { projects } = await scan({ cwd: root });
    const p = projects[0]!;
    writeWithBackup(planFileChanges([{ entry: p.deps[0]!, newRaw: '1.0.0' }]), { cwd: root, command: 'up' });
    writeFileSync(p.file, '{}\n');
    expect(undo()!.restored).toEqual([]);
    expect(undo(undefined, true)!.restored).toEqual([p.file]);
    expect(readFileSync(p.file, 'utf8')).toBe(text);
  });

  it('refuses to write when the file changed since the scan', async () => {
    const root = fixture({ 'package.json': text });
    const { projects } = await scan({ cwd: root });
    writeFileSync(projects[0]!.file, text.replace('a', 'b'));
    expect(() => planFileChanges([{ entry: projects[0]!.deps[0]!, newRaw: '1.0.0' }])).toThrow(/changed on disk/);
  });
});
