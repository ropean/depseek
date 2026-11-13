import type { Conflict, PeerProblem } from '../conflicts.js';
import type { Painter, Role } from '../util/color.js';
import { listShort, plural, table } from '../util/text.js';

const TYPE_LABEL: Record<Conflict['type'], string> = {
  major: 'major versions differ',
  minor: 'minor / patch differ',
  format: 'written differently',
  section: 'dependencies vs devDependencies',
};
const SEV_SYMBOL: Record<Conflict['severity'], string> = { high: '●', medium: '◐', low: '○', hint: 'ℹ' };

export function renderConflicts(
  p: Painter,
  conflicts: Conflict[],
  peers: PeerProblem[],
  suggestion: (c: Conflict) => string | undefined,
): string {
  const out: string[] = [];
  for (const c of conflicts) {
    const role: Role = c.severity;
    const head = `${p.paint('accent', c.name)}  ${p.paint(role, `${SEV_SYMBOL[c.severity]} ${c.severity}`)} ${p.paint('dim', `· ${TYPE_LABEL[c.type]}`)}${c.group ? p.paint('hint', `  [${c.group}]`) : ''}`;
    out.push(head);
    if (c.type === 'section') {
      const rows = c.sections!.map((s) => {
        const es = c.variants.flatMap((v) => v.entries).filter((e) => e.section === s);
        return [
          p.paint('dim', s),
          `×${es.length}`,
          p.paint(
            'path',
            listShort(
              es.map((e) => e.project.relDir),
              4,
            ),
          ),
        ];
      });
      out.push(table(rows, { indent: '  ' }));
    } else {
      const rows = c.variants.map((v) => [
        v.raw,
        p.paint('dim', `×${v.entries.length}`),
        p.paint(
          'path',
          listShort(
            v.entries.map((e) => e.project.relDir + (e.section === 'devDependencies' ? p.paint('dim', ' (dev)') : '')),
            4,
          ),
        ),
      ]);
      out.push(table(rows, { indent: '  ' }));
      const target = suggestion(c);
      if (target) out.push(`  ${p.paint('ok', `→ ${target}`)}`);
    }
    out.push('');
  }
  if (peers.length) {
    out.push(p.paint('high', '● Unmet peer dependencies (installed versions)'));
    out.push(
      table(
        peers.map((x) => [
          p.paint('path', x.project.relDir),
          `${x.pkg}${x.pkgVersion ? `@${x.pkgVersion}` : ''}`,
          p.paint('dim', 'wants'),
          `${x.peer}@${x.range}`,
          p.paint('dim', 'installed'),
          p.paint('high', x.installed),
        ]),
        { indent: '  ' },
      ),
    );
    out.push('');
  }
  const real = conflicts.filter((c) => c.severity !== 'hint');
  if (!real.length && !peers.length) out.push(p.paint('ok', '✓ No version conflicts.'));
  else {
    const major = real.filter((c) => c.type === 'major').length;
    out.push(
      `${p.paint('accent', plural(real.length, 'dependency has', 'dependencies have'))} conflicts` +
        (major ? `, ${p.paint('high', `${major} across major versions`)}` : '') +
        (peers.length
          ? `, ${p.paint('high', plural(peers.length, 'unmet peer dependency', 'unmet peer dependencies'))}`
          : ''),
    );
  }
  return out.join('\n').trimEnd();
}

export function conflictsToJson(conflicts: Conflict[], peers: PeerProblem[]): unknown {
  return {
    conflicts: conflicts.map((c) => ({
      name: c.name,
      group: c.group,
      severity: c.severity,
      type: c.type,
      variants: c.variants.map((v) => ({
        spec: v.raw,
        projects: v.entries.map((e) => ({ project: e.project.rel, section: e.section })),
      })),
    })),
    peers: peers.map((x) => ({
      project: x.project.rel,
      package: x.pkg,
      version: x.pkgVersion,
      peer: x.peer,
      range: x.range,
      installed: x.installed,
    })),
  };
}

export function conflictsToMarkdown(conflicts: Conflict[], peers: PeerProblem[]): string {
  const lines = ['| Package | Severity | Versions |', '| --- | --- | --- |'];
  for (const c of conflicts) {
    const vs = c.variants
      .map((v) => `\`${v.raw}\` (${v.entries.map((e) => e.project.relDir).join(', ')})`)
      .join('<br>');
    lines.push(`| ${c.name} | ${c.severity} · ${TYPE_LABEL[c.type]} | ${vs.replace(/\|/g, '\\|')} |`);
  }
  if (peers.length) {
    lines.push('', '### Unmet peer dependencies', '');
    for (const x of peers)
      lines.push(`- \`${x.project.relDir}\`: ${x.pkg} wants \`${x.peer}@${x.range}\`, installed ${x.installed}`);
  }
  return `${conflicts.length ? lines.join('\n') : '_No version conflicts._'}\n`;
}
