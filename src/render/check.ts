import type { Analysis, Update } from '../analyze.js';
import type { Project } from '../project.js';
import { changelogUrl } from '../registry.js';
import { planFileChanges } from '../write.js';
import type { Painter } from '../util/color.js';
import { listShort, plural, relativeTime, table } from '../util/text.js';
import { LEVELS, type Level } from '../versions.js';
import { highlightChange, levelLabel, levelRole } from './common.js';

export type GroupBy = 'package' | 'project' | 'level';

const LEVEL_ORDER: Record<Level, number> = { major: 0, minor: 1, patch: 2, prerelease: 3 };

interface Row {
  name: string;
  section: string;
  raw: string;
  newRaw: string;
  sample: Update;
  projects: Project[];
}

/** Merge identical changes (same package, from, to) across projects. */
export function mergeRows(updates: Update[]): Row[] {
  const rows = new Map<string, Row>();
  for (const u of updates) {
    const key = `${u.name}\0${u.entry.raw}\0${u.newRaw}\0${u.entry.kind === 'overrides' ? 'o' : ''}`;
    const r = rows.get(key);
    if (r) {
      if (!r.projects.includes(u.entry.project)) r.projects.push(u.entry.project);
    } else {
      rows.set(key, {
        name: u.name,
        section: u.entry.section,
        raw: u.entry.raw,
        newRaw: u.newRaw,
        sample: u,
        projects: [u.entry.project],
      });
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      LEVEL_ORDER[a.sample.level] - LEVEL_ORDER[b.sample.level] ||
      a.name.localeCompare(b.name) ||
      a.raw.localeCompare(b.raw),
  );
}

const sectionTag = (section: string): string =>
  ['dependencies', 'devDependencies', 'optionalDependencies'].includes(section) ? '' : section;

function rowCells(p: Painter, r: Row, withProjects: boolean): string[] {
  const u = r.sample;
  const tag = sectionTag(r.section);
  const flags: string[] = [];
  const warns = u.warnings.filter((w) => w.type !== 'fixes').length;
  if (u.warnings.some((w) => w.type === 'fixes')) flags.push(p.paint('ok', '✓ security fix'));
  if (warns) flags.push(p.paint('warn', `⚠ ${warns}`));
  return [
    r.name + (tag ? ` ${p.paint('dim', `(${tag})`)}` : ''),
    r.raw,
    p.paint('dim', '→'),
    highlightChange(p, u.current, r.newRaw, levelRole(u)),
    p.paint(levelRole(u), levelLabel(u)),
    p.paint('dim', relativeTime(u.published)),
    [
      withProjects
        ? p.paint(
            'dim',
            listShort(
              r.projects.map((x) => x.relDir),
              3,
            ),
          )
        : '',
      ...flags,
    ]
      .filter(Boolean)
      .join(' '),
  ];
}

export function renderUpdates(
  p: Painter,
  a: Analysis,
  groupBy: GroupBy,
  opts: { showWarnings?: boolean } = {},
): string {
  const out: string[] = [];
  if (!a.updates.length) {
    out.push(p.paint('ok', '✓ All dependencies match the selected target.'));
  } else if (groupBy === 'project') {
    const byProject = new Map<Project, Update[]>();
    for (const u of a.updates) {
      if (!byProject.has(u.entry.project)) byProject.set(u.entry.project, []);
      byProject.get(u.entry.project)!.push(u);
    }
    const projects = [...byProject.keys()].sort((x, y) => x.rel.localeCompare(y.rel));
    for (const proj of projects) {
      out.push(`${p.paint('path', proj.rel)}${proj.name ? p.paint('dim', `  ${proj.name}`) : ''}`);
      out.push(
        table(
          mergeRows(byProject.get(proj)!).map((r) => rowCells(p, r, false)),
          { indent: '  ' },
        ),
      );
      out.push('');
    }
  } else if (groupBy === 'level') {
    const rows = mergeRows(a.updates);
    for (const level of LEVELS) {
      const lr = rows.filter((r) => r.sample.level === level);
      if (!lr.length) continue;
      out.push(
        p.paint(
          level,
          p.style('bold', `${level === 'prerelease' ? 'Prerelease' : level[0]!.toUpperCase() + level.slice(1)}`),
        ),
      );
      out.push(
        table(
          lr.map((r) => rowCells(p, r, true)),
          { indent: '  ' },
        ),
      );
      out.push('');
    }
  } else {
    out.push(table(mergeRows(a.updates).map((r) => rowCells(p, r, true))));
    out.push('');
  }

  if (opts.showWarnings !== false) {
    const warned = mergeRows(a.updates.filter((u) => u.warnings.length));
    if (warned.length) {
      out.push(p.paint('warn', 'Notes'));
      const seen = new Set<string>();
      for (const r of warned) {
        for (const u of a.updates.filter((x) => x.name === r.name && x.newRaw === r.newRaw)) {
          for (const w of u.warnings) {
            const mark = w.type === 'fixes' ? p.paint('ok', '✓') : p.paint('warn', '⚠');
            const line = `  ${mark} ${r.name} ${p.paint('dim', `[${w.type}]`)} ${w.message}`;
            if (seen.has(line)) continue;
            seen.add(line);
            out.push(line);
          }
        }
      }
      out.push('');
    }
  }
  out.push(...renderNotes(p, a));
  out.push(renderFooter(p, a));
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

function renderNotes(p: Painter, a: Analysis): string[] {
  const out: string[] = [];
  if (a.vulnerable.length) {
    out.push(p.paint('high', '● Known vulnerabilities (OSV)'));
    const rows = new Map<string, string[]>();
    for (const v of a.vulnerable) {
      const key = `${v.entry.name}@${v.version}`;
      if (!rows.has(key)) {
        const ids = v.vulns.map(
          (x) =>
            `${x.aliases.find((al) => al.startsWith('CVE-')) ?? x.id}${x.severity ? ` (${x.severity.toLowerCase()})` : ''}`,
        );
        rows.set(key, [
          p.paint('high', key),
          ids.join(', '),
          v.fixedIn ? p.paint('ok', `fix: ≥ ${v.fixedIn}`) : p.paint('dim', 'no fix yet'),
          '',
        ]);
      }
      const r = rows.get(key)!;
      r[3] = p.paint('dim', listShort([...new Set([...(r[3] ? r[3].split(', ') : []), v.entry.project.relDir])]));
    }
    out.push(table([...rows.values()], { indent: '  ' }));
    out.push('');
  }
  if (a.auditError) out.push(p.paint('warn', `⚠ Vulnerability check failed: ${a.auditError}`), '');
  else if (a.audited && !a.vulnerable.length) out.push(p.paint('ok', '✓ No known vulnerabilities (OSV)'), '');
  if (a.deprecated.length) {
    out.push(p.paint('deprecated', '⚠ Deprecated versions in use'));
    const seen = new Set<string>();
    for (const d of a.deprecated) {
      const key = `${d.entry.name}@${d.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const where = a.deprecated
        .filter((x) => x.entry.name === d.entry.name && x.version === d.version)
        .map((x) => x.entry.project.relDir);
      out.push(`  ${p.paint('deprecated', key)}  ${d.message}  ${p.paint('dim', listShort([...new Set(where)]))}`);
    }
    out.push('');
  }
  if (a.errors.size) {
    out.push(p.paint('error', 'Could not check'));
    for (const [name, err] of a.errors) out.push(`  ${name}  ${p.paint('dim', err)}`);
    out.push('');
  }
  const unc = a.skipped.filter((s) => s.uncheckable);
  if (unc.length) {
    out.push(
      p.paint(
        'dim',
        `Cannot check (git / url): ${listShort([...new Set(unc.map((s) => `${s.entry.name}@${s.entry.raw}`))], 5)}`,
      ),
    );
  }
  if (a.ignored.length) {
    const names = [...new Map(a.ignored.map((i) => [i.entry.name, i.reason])).entries()];
    out.push(
      p.paint(
        'dim',
        `Ignored by config: ${listShort(
          names.map(([n, r]) => `${n} (${r})`),
          5,
        )}`,
      ),
    );
  }
  if (a.filteredByLevel) out.push(p.paint('dim', `${plural(a.filteredByLevel, 'update')} hidden by --level`));
  return out;
}

export function levelCounts(updates: Update[]): Record<Level, number> {
  const counts: Record<Level, number> = { major: 0, minor: 0, patch: 0, prerelease: 0 };
  const seen = new Set<string>();
  for (const u of updates) {
    const key = `${u.name}\0${u.newRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    counts[u.level]++;
  }
  return counts;
}

export function renderFooter(p: Painter, a: Analysis): string {
  if (!a.updates.length) return '';
  const c = levelCounts(a.updates);
  const parts = [
    p.paint('patch', `patch ${c.patch}`),
    p.paint('minor', `minor ${c.minor}`),
    p.paint('major', `major ${c.major}`),
  ];
  if (c.prerelease) parts.push(p.paint('prerelease', `prerelease ${c.prerelease}`));
  const files = new Set(a.updates.map((u) => u.entry.project.file)).size;
  return `${parts.join(p.paint('dim', ' · '))}  ${p.paint('dim', `in ${plural(files, 'file')}`)}`;
}

export function updatesToJson(a: Analysis): unknown {
  return {
    updates: a.updates.map((u) => ({
      name: u.name,
      project: u.entry.project.rel,
      section: u.entry.section,
      current: u.entry.raw,
      target: u.target,
      newSpec: u.newRaw,
      level: u.level,
      breaking: u.level === 'major',
      published: u.published,
      changelog: changelogUrl(a.metas.get(u.name)),
      warnings: u.warnings,
    })),
    deprecated: a.deprecated.map((d) => ({
      name: d.entry.name,
      version: d.version,
      project: d.entry.project.rel,
      message: d.message,
    })),
    errors: Object.fromEntries(a.errors),
    skipped: a.skipped.map((s) => ({
      name: s.entry.name,
      spec: s.entry.raw,
      project: s.entry.project.rel,
      reason: s.reason,
    })),
    vulnerabilities: a.vulnerable.map((v) => ({
      name: v.entry.name,
      version: v.version,
      project: v.entry.project.rel,
      fixedIn: v.fixedIn,
      ids: v.vulns.map((x) => x.id),
    })),
    summary: levelCounts(a.updates),
  };
}

export function updatesToMarkdown(a: Analysis): string {
  const rows = mergeRows(a.updates);
  if (!rows.length) return '_All dependencies are up to date._\n';
  const esc = (s: string): string => s.replace(/\|/g, '\\|');
  const lines = ['| Package | From | To | Level | Projects |', '| --- | --- | --- | --- | --- |'];
  for (const r of rows) {
    const link = changelogUrl(a.metas.get(r.name));
    const name = link ? `[${esc(r.name)}](${link})` : esc(r.name);
    lines.push(
      `| ${name} | \`${esc(r.raw)}\` | \`${esc(r.newRaw)}\` | ${r.sample.zero ? 'major (0.x)' : r.sample.level} | ${esc(r.projects.map((x) => x.relDir).join(', '))} |`,
    );
  }
  const c = levelCounts(a.updates);
  lines.push(
    '',
    `**patch** ${c.patch} · **minor** ${c.minor} · **major** ${c.major}${c.prerelease ? ` · **prerelease** ${c.prerelease}` : ''}`,
  );
  const warns = a.updates.flatMap((u) => u.warnings.map((w) => `- ⚠️ **${u.name}** (${w.type}): ${w.message}`));
  if (warns.length) lines.push('', '### Warnings', '', ...new Set(warns));
  return `${lines.join('\n')}\n`;
}

const JSON_DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'packageManager',
];

/**
 * ncu-compatible JSON: --jsonUpgraded ({ name: newSpec }), --jsonAll (new package.json),
 * --jsonDeps (its dependency sections). One project → the object itself; several → keyed by file.
 */
export function updatesToNcuJson(a: Analysis, mode: 'all' | 'deps' | 'upgraded'): unknown {
  const projects = a.projects ?? [...new Set(a.entries.map((e) => e.project))];
  const out: Record<string, unknown> = {};
  for (const p of projects) {
    const ups = a.updates.filter((u) => u.entry.project === p);
    if (mode === 'upgraded') {
      out[p.rel] = Object.fromEntries(ups.map((u) => [u.name, u.newRaw]));
      continue;
    }
    const after = planFileChanges(ups.map((u) => ({ entry: u.entry, newRaw: u.newRaw })))[0]?.after ?? p.text;
    const json = JSON.parse(after) as Record<string, unknown>;
    out[p.rel] =
      mode === 'all' ? json : Object.fromEntries(JSON_DEP_SECTIONS.filter((k) => k in json).map((k) => [k, json[k]]));
  }
  const keys = Object.keys(out);
  return keys.length === 1 ? out[keys[0]!] : out;
}
