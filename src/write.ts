import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { applyStringEdits } from './jsonEdit.js';
import type { DepEntry, Project } from './project.js';
import { cacheDir } from './registry.js';
import type { Painter } from './util/color.js';

export interface Change {
  entry: DepEntry;
  newRaw: string;
}

export interface FileChange {
  project: Project;
  before: string;
  after: string;
  changes: Change[];
}

/** Apply changes to each project's text in memory (nothing is written yet). */
export function planFileChanges(changes: Change[]): FileChange[] {
  const byProject = new Map<Project, Change[]>();
  for (const c of changes) {
    if (!byProject.has(c.entry.project)) byProject.set(c.entry.project, []);
    byProject.get(c.entry.project)!.push(c);
  }
  const out: FileChange[] = [];
  for (const [project, list] of byProject) {
    // Re-read so we never clobber edits made since the scan.
    const before = readFileSync(project.file, 'utf8');
    if (before !== project.text)
      throw new Error(`${project.rel} changed on disk since it was scanned; re-run depseek.`);
    const after = applyStringEdits(
      before,
      list.map((c) => ({ path: c.entry.path, value: c.entry.encode ? c.entry.encode(c.newRaw) : c.newRaw })),
    );
    if (after !== before) out.push({ project, before, after, changes: list });
  }
  return out.sort((a, b) => a.project.rel.localeCompare(b.project.rel));
}

/** Unified diff; edits never add or remove lines, so a line-by-line comparison is exact. */
export function unifiedDiff(rel: string, before: string, after: string, p: Painter, context = 2): string {
  const lines = (t: string): string[] => (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
  const a = lines(before);
  const b = lines(after);
  const changed: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) changed.push(i);
  if (!changed.length) return '';
  const out = [p.paint('accent', `--- a/${rel}`), p.paint('accent', `+++ b/${rel}`)];
  let i = 0;
  while (i < changed.length) {
    let j = i;
    while (j + 1 < changed.length && changed[j + 1]! - changed[j]! <= context * 2 + 1) j++;
    const start = Math.max(0, changed[i]! - context);
    const end = Math.min(a.length - 1, changed[j]! + context);
    const len = end - start + 1;
    out.push(p.paint('hint', `@@ -${start + 1},${len} +${start + 1},${len} @@`));
    for (let k = start; k <= end; k++) {
      const strip = (s: string | undefined): string => (s ?? '').replace(/\r$/, '');
      if (a[k] === b[k]) out.push(` ${strip(a[k])}`);
      else {
        out.push(p.paint('error', `-${strip(a[k])}`));
        out.push(p.paint('ok', `+${strip(b[k])}`));
      }
    }
    i = j + 1;
  }
  return out.join('\n');
}

// ── git ─────────────────────────────────────────────────────────────────────

export function gitRoot(dir: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

/** Files (among `files`) with uncommitted changes. Files outside a git repo are never dirty. */
export function dirtyFiles(files: string[]): string[] {
  const dirty: string[] = [];
  for (const f of files) {
    try {
      const out = execFileSync('git', ['status', '--porcelain', '--', f], {
        cwd: dirname(f),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (out.trim()) dirty.push(f);
    } catch {
      /* not a git repo / git missing */
    }
  }
  return dirty;
}

export function gitCommit(files: string[], message: string): { root: string; ok: boolean; error?: string }[] {
  const byRoot = new Map<string, string[]>();
  for (const f of files) {
    if (!existsSync(f)) continue;
    const root = gitRoot(dirname(f));
    if (!root) continue;
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root)!.push(f);
  }
  const results: { root: string; ok: boolean; error?: string }[] = [];
  for (const [root, fs] of byRoot) {
    try {
      execFileSync('git', ['add', '--', ...fs], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', message, '--', ...fs], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
      results.push({ root, ok: true });
    } catch (e) {
      results.push({
        root,
        ok: false,
        error: (e as { stderr?: Buffer }).stderr?.toString().trim() || (e as Error).message,
      });
    }
  }
  return results;
}

// ── backups / undo ──────────────────────────────────────────────────────────

export interface BackupManifest {
  id: string;
  createdAt: string;
  cwd: string;
  command: string;
  files: { path: string; backup: string; writtenHash: string }[];
}

const MAX_BACKUPS = 20;
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

export function backupsDir(): string {
  return join(cacheDir(), 'backups');
}

export function listBackups(): BackupManifest[] {
  const dir = backupsDir();
  if (!existsSync(dir)) return [];
  const out: BackupManifest[] = [];
  for (const id of readdirSync(dir)) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8')) as BackupManifest);
    } catch {
      /* skip partial backups */
    }
  }
  return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** Back up the original contents, then write the new contents. Returns the backup id. */
export function writeWithBackup(files: FileChange[], meta: { cwd: string; command: string }): string {
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
  const dir = join(backupsDir(), id);
  mkdirSync(dir, { recursive: true });
  const manifest: BackupManifest = { id, createdAt: new Date().toISOString(), ...meta, files: [] };
  files.forEach((f, i) => {
    const name = `${i}.json`;
    writeFileSync(join(dir, name), f.before);
    manifest.files.push({ path: f.project.file, backup: name, writtenHash: sha(f.after) });
  });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  for (const f of files) {
    writeFileSync(f.project.file, f.after);
    f.project.text = f.after;
  }
  for (const old of listBackups().slice(MAX_BACKUPS))
    rmSync(join(backupsDir(), old.id), { recursive: true, force: true });
  return id;
}

export interface UndoResult {
  manifest: BackupManifest;
  restored: string[];
  modified: string[];
}

/**
 * Restore the files of a backup (default: the most recent). Files edited after depseek wrote
 * them are left alone unless `force` is set.
 */
export function undo(id?: string, force = false): UndoResult | undefined {
  const all = listBackups();
  const manifest = id ? all.find((b) => b.id === id || b.id.startsWith(id)) : all[0];
  if (!manifest) return undefined;
  const dir = join(backupsDir(), manifest.id);
  const modified = manifest.files
    .filter((f) => existsSync(f.path) && sha(readFileSync(f.path, 'utf8')) !== f.writtenHash)
    .map((f) => f.path);
  if (modified.length && !force) return { manifest, restored: [], modified };
  const restored: string[] = [];
  for (const f of manifest.files) {
    writeFileSync(f.path, readFileSync(join(dir, f.backup)));
    restored.push(f.path);
  }
  rmSync(dir, { recursive: true, force: true });
  return { manifest, restored, modified };
}

/** Record the current contents as "written" so `undo` accepts them (used after doctor runs). */
export function refreshBackup(id: string): void {
  const file = join(backupsDir(), id, 'manifest.json');
  const m = JSON.parse(readFileSync(file, 'utf8')) as BackupManifest;
  for (const f of m.files) if (existsSync(f.path)) f.writtenHash = sha(readFileSync(f.path, 'utf8'));
  writeFileSync(file, JSON.stringify(m, null, 2));
}
