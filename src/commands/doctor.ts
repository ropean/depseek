import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Update } from '../analyze.js';
import type { Ctx } from '../context.js';
import { installTargets, runInstalls, runShell } from '../install.js';
import type { PackageManager, Project } from '../project.js';
import { mergeRows } from '../render/check.js';
import { plural, table, toPosix } from '../util/text.js';
import { dirtyFiles, planFileChanges, refreshBackup, writeWithBackup, type FileChange } from '../write.js';
import { prepare, printSummary, runAnalysis } from './shared.js';

interface Outcome {
  name: string;
  from: string;
  to: string;
  ok: boolean;
  stage?: 'install' | 'test';
  output?: string;
}

/**
 * `depseek doctor [--test <cmd>]`: upgrade one package at a time, install and run the tests;
 * keep the upgrade when they pass, revert it when they fail.
 */
export async function doctorCommand(ctx: Ctx, roots: string[]): Promise<number> {
  const { paint } = ctx.painter;
  const prep = await prepare(ctx, roots);
  if (!prep) return 1;
  printSummary(ctx, prep.result);
  const a = await runAnalysis(ctx, prep);
  if (!a.updates.length) {
    ctx.out(paint('ok', '✓ Nothing to upgrade.'));
    return 0;
  }
  const defaultPm = (ctx.config.packageManager as PackageManager | undefined) ?? 'bun';
  const testFor = (p: Project): string =>
    (ctx.opts.test as string | undefined) ?? `${p.effectiveLock?.pm ?? defaultPm} run test`;
  const rel = (d: string): string => toPosix(relative(ctx.cwd, d)) || '.';

  const allProjects = [...new Set(a.updates.map((u) => u.entry.project))];
  if ((ctx.opts.gitCheck ?? ctx.config.gitCheck ?? true) !== false) {
    const dirty = dirtyFiles(allProjects.map((p) => p.file));
    if (dirty.length) {
      ctx.err(
        paint('error', `✖ Uncommitted changes in ${dirty.map(rel).join(', ')} — commit first or pass --no-git-check.`),
      );
      return 1;
    }
  }

  const runTests = async (projects: Project[]): Promise<{ ok: boolean; output: string }> => {
    for (const p of projects) {
      const r = await runShell(testFor(p), p.dir);
      if (r.code !== 0) return { ok: false, output: `${rel(p.dir)}$ ${testFor(p)}\n${r.output}` };
    }
    return { ok: true, output: '' };
  };
  const install = async (projects: Project[]): Promise<{ ok: boolean; output: string }> => {
    const results = await runInstalls(installTargets(projects, defaultPm));
    const bad = results.find((r) => !r.ok);
    return bad
      ? { ok: false, output: `${rel(bad.target.dir)}$ ${bad.target.pm} install\n${bad.output}` }
      : { ok: true, output: '' };
  };

  ctx.out(paint('dim', `Baseline: running tests in ${plural(allProjects.length, 'project')}…`));
  const base = await runTests(allProjects);
  if (!base.ok) {
    ctx.err(paint('error', '✖ Tests fail before any upgrade; fix them first.'));
    ctx.err(base.output.trim().split('\n').slice(-30).join('\n'));
    return 1;
  }

  // One backup of every file doctor may touch, so `depseek undo` reverts the whole run.
  const all = planFileChanges(a.updates.map((u) => ({ entry: u.entry, newRaw: u.newRaw })));
  const originals = new Map(all.map((f) => [f.project, f.before]));
  const backupId = writeWithBackup(
    all.map((f) => ({ ...f, after: f.before })),
    { cwd: ctx.cwd, command: 'doctor' },
  );
  for (const f of all) f.project.text = originals.get(f.project)!;

  const byName = new Map<string, Update[]>();
  for (const u of a.updates) {
    if (!byName.has(u.name)) byName.set(u.name, []);
    byName.get(u.name)!.push(u);
  }
  const outcomes: Outcome[] = [];
  for (const [name, ups] of byName) {
    const rows = mergeRows(ups);
    const from = [...new Set(rows.map((r) => r.raw))].join(', ');
    const to = [...new Set(rows.map((r) => r.newRaw))].join(', ');
    process.stdout.write(`${paint('accent', name)} ${from} → ${to} … `);
    const files: FileChange[] = planFileChanges(ups.map((u) => ({ entry: u.entry, newRaw: u.newRaw })));
    for (const f of files) {
      writeFileSync(f.project.file, f.after);
      f.project.text = f.after;
    }
    const projects = files.map((f) => f.project);
    const inst = await install(projects);
    const test = inst.ok ? await runTests(projects) : inst;
    if (inst.ok && test.ok) {
      ctx.out(paint('ok', '✓ tests pass'));
      outcomes.push({ name, from, to, ok: true });
    } else {
      ctx.out(paint('error', `✖ ${inst.ok ? 'tests fail' : 'install fails'} — reverted`));
      for (const f of files) {
        writeFileSync(f.project.file, f.before);
        f.project.text = f.before;
      }
      outcomes.push({ name, from, to, ok: false, stage: inst.ok ? 'test' : 'install', output: test.output });
    }
  }

  // Bring lock files back in line after reverts.
  if (outcomes.some((o) => !o.ok)) {
    ctx.out(paint('dim', 'Re-installing to sync lock files…'));
    await install(allProjects);
  }

  refreshBackup(backupId);
  ctx.out();
  ctx.out(
    table(
      outcomes.map((o) => [
        o.ok ? paint('ok', '✓') : paint('error', '✖'),
        o.name,
        o.from,
        paint('dim', '→'),
        o.to,
        o.ok ? paint('ok', 'kept') : paint('error', `reverted (${o.stage} failed)`),
      ]),
    ),
  );
  for (const o of outcomes.filter((x) => !x.ok && x.output)) {
    ctx.out();
    ctx.out(paint('error', `── ${o.name} ──`));
    ctx.out(paint('dim', o.output!.trim().split('\n').slice(-15).join('\n')));
  }
  const kept = outcomes.filter((o) => o.ok).length;
  ctx.out();
  ctx.out(
    `${paint('ok', `${kept} upgraded`)}, ${paint(kept === outcomes.length ? 'dim' : 'error', `${outcomes.length - kept} reverted`)}. ${paint('dim', 'Undo everything with: depseek undo')}`,
  );
  return kept === outcomes.length ? 0 : 1;
}
