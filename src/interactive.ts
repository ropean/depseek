import { spawn } from 'node:child_process';
import { emitKeypressEvents } from 'node:readline';
import semver from 'semver';
import { resolveFormat, type Analysis, type Update } from './analyze.js';
import type { Ctx } from './context.js';
import { changelogUrl, type PackageMeta } from './registry.js';
import { highlightChange, levelLabel } from './render/common.js';
import { formatSpec, type Format } from './spec.js';
import { padEnd, plural, relativeTime, width } from './util/text.js';
import { diffLevel, LEVELS, pickTarget, type Level } from './versions.js';

interface Item {
  base: Update;
  current: Update;
  checked: boolean;
}

interface Row {
  name: string;
  meta?: PackageMeta;
  versions: { version: string; label: string }[];
  vi: number;
  items: Item[];
  expanded: boolean;
}

type Focus = { row: Row; item?: Item };

/** Re-point an update at another version, keeping its entry and format. */
export function retarget(ctx: Ctx, u: Update, version: string, meta: PackageMeta | undefined): Update | undefined {
  if (!semver.gt(version, u.current) && !u.explicit) return undefined;
  const fmt = resolveFormat(
    u.entry,
    ctx.opts.format as Format | undefined,
    ctx.config.format,
    ctx.opts.target as string | undefined,
  );
  const lvl = diffLevel(u.current, version);
  return {
    ...u,
    target: version,
    newRaw: formatSpec(u.entry.spec, version, fmt),
    level: lvl.level,
    zero: lvl.zero,
    published: meta?.time[version],
    warnings: version === u.target ? u.warnings : [],
  };
}

function alternatives(meta: PackageMeta | undefined, updates: Update[]): { version: string; label: string }[] {
  const first = updates[0]!;
  const out = new Map<string, string>();
  out.set(first.target, 'suggested');
  if (meta) {
    const lowest = semver.sort(updates.map((u) => u.current))[0]!;
    for (const s of ['latest', 'minor', 'patch', 'greatest'] as const) {
      const v = pickTarget(meta, lowest, s, undefined);
      if (v && !out.has(v)) out.set(v, s);
    }
  }
  return [...out].map(([version, label]) => ({ version, label })).sort((a, b) => semver.rcompare(a.version, b.version));
}

function rowLevel(r: Row): Level {
  const order = LEVELS;
  const lv = r.items.map((i) => i.current.level);
  return order.find((l) => lv.includes(l)) ?? 'patch';
}

const DEFAULT_ON: ReadonlySet<Level> = new Set(['patch', 'minor']);

function buildRows(a: Analysis): Row[] {
  const byName = new Map<string, Update[]>();
  for (const u of a.updates) {
    const key = `${u.name}\0${u.target}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(u);
  }
  const rows: Row[] = [];
  for (const ups of byName.values()) {
    const meta = a.metas.get(ups[0]!.name);
    rows.push({
      name: ups[0]!.name,
      meta,
      versions: alternatives(meta, ups),
      vi: 0,
      items: ups.map((u) => ({ base: u, current: u, checked: DEFAULT_ON.has(u.level) && !u.zero })),
      expanded: false,
    });
  }
  for (const r of rows)
    r.vi = Math.max(
      0,
      r.versions.findIndex((v) => v.version === r.items[0]!.base.target),
    );
  const order: Record<Level, number> = { patch: 0, minor: 1, major: 2, prerelease: 3 };
  return rows.sort((x, y) => order[rowLevel(x)] - order[rowLevel(y)] || x.name.localeCompare(y.name));
}

function openUrl(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* ignore */
  }
}

/** Full-screen picker. Resolves to the chosen updates, or undefined when cancelled. */
export function interactiveSelect(ctx: Ctx, a: Analysis): Promise<Update[] | undefined> {
  const { paint, style } = ctx.painter;
  const rows = buildRows(a);
  if (!rows.length) return Promise.resolve([]);
  const stdin = process.stdin;
  const out = process.stdout;
  let cursor = 0;
  let scroll = 0;
  let search = '';
  let searching = false;
  let confirming = false;
  let message = '';

  const visibleRows = (): Row[] => (search ? rows.filter((r) => r.name.includes(search)) : rows);
  const focusables = (): Focus[] => {
    const f: Focus[] = [];
    for (const r of visibleRows()) {
      f.push({ row: r });
      if (r.expanded) for (const it of r.items) f.push({ row: r, item: it });
    }
    return f;
  };
  const selected = (): Update[] => rows.flatMap((r) => r.items.filter((i) => i.checked).map((i) => i.current));
  const rowState = (r: Row): 'all' | 'some' | 'none' => {
    const n = r.items.filter((i) => i.checked).length;
    return n === 0 ? 'none' : n === r.items.length ? 'all' : 'some';
  };
  const box = (s: 'all' | 'some' | 'none'): string =>
    s === 'all' ? paint('ok', '◉') : s === 'some' ? paint('warn', '◐') : paint('dim', '○');

  const setVersion = (r: Row, vi: number): void => {
    r.vi = (vi + r.versions.length) % r.versions.length;
    const v = r.versions[r.vi]!.version;
    for (const it of r.items) {
      const next = retarget(ctx, it.base, v, r.meta);
      if (next) it.current = next;
      else it.checked = false;
    }
  };

  const render = (): void => {
    const rowsAvail = Math.max(5, (out.rows ?? 24) - 5);
    const lines: string[] = [];
    if (confirming) {
      const sel = selected();
      const files = new Set(sel.map((u) => u.entry.project.file)).size;
      const deps = new Set(sel.map((u) => u.name)).size;
      lines.push(style('bold', 'Confirm'));
      lines.push('');
      lines.push(
        `Write ${plural(deps, 'dependency', 'dependencies')} (${plural(sel.length, 'change')}) to ${plural(files, 'file')}?`,
      );
      lines.push('');
      lines.push(paint('dim', 'y / enter: write   n / esc: back'));
      out.write(`\x1b[H\x1b[2J${lines.join('\n')}`);
      return;
    }
    const f = focusables();
    cursor = Math.min(cursor, Math.max(0, f.length - 1));
    const sel = selected();
    lines.push(
      `${style('bold', 'Select updates')}  ${paint('dim', `${plural(new Set(sel.map((u) => u.name)).size, 'dependency', 'dependencies')} · ${plural(new Set(sel.map((u) => u.entry.project.file)).size, 'file')} selected`)}`,
    );
    lines.push(
      paint(
        'dim',
        'space toggle · a all · p/m/M patch/minor/major · → expand · v version · o changelog · / search · enter confirm · q quit',
      ),
    );
    if (searching || search) lines.push(`${paint('hint', '/')}${search}${searching ? '▏' : ''}`);
    else lines.push('');

    const body: { text: string; focusIndex?: number }[] = [];
    let lastLevel: Level | undefined;
    let fi = 0;
    const nameW = Math.min(40, Math.max(...visibleRows().map((r) => width(r.name))));
    for (const r of visibleRows()) {
      const lvl = rowLevel(r);
      if (lvl !== lastLevel) {
        body.push({ text: paint(lvl, style('bold', `── ${lvl} ──`)) });
        lastLevel = lvl;
      }
      const u = r.items[0]!.current;
      const currents = [...new Set(r.items.map((i) => i.base.entry.raw))];
      const proj =
        r.items.length > 1
          ? paint('dim', plural(r.items.length, 'project'))
          : paint('dim', r.items[0]!.base.entry.project.relDir);
      body.push({
        focusIndex: fi++,
        text: `${box(rowState(r))} ${padEnd(r.name, nameW)}  ${padEnd(currents.join(', '), 18)} ${paint('dim', '→')} ${padEnd(highlightChange(ctx.painter, u.current, u.newRaw, u.level), 14)} ${padEnd(paint(u.level, levelLabel(u)), 16)} ${padEnd(paint('dim', relativeTime(u.published)), 14)} ${proj}${u.warnings.length ? ` ${paint('warn', `⚠ ${u.warnings.length}`)}` : ''}`,
      });
      if (r.expanded) {
        const vs = r.versions
          .map((v, i) =>
            i === r.vi ? paint('accent', `[${v.version} ${v.label}]`) : paint('dim', `${v.version} ${v.label}`),
          )
          .join('  ');
        body.push({ text: `      ${paint('dim', 'versions')}  ${vs}` });
        const link = changelogUrl(r.meta);
        if (link) body.push({ text: `      ${paint('dim', 'changelog')} ${paint('hint', link)}` });
        for (const w of u.warnings) body.push({ text: `      ${paint('warn', `⚠ ${w.message}`)}` });
        for (const it of r.items) {
          body.push({
            focusIndex: fi++,
            text: `      ${box(it.checked ? 'all' : 'none')} ${padEnd(paint('path', it.base.entry.project.relDir), 30)} ${it.base.entry.raw} ${paint('dim', '→')} ${it.current.newRaw}${it.base.entry.section !== 'dependencies' ? paint('dim', `  ${it.base.entry.section}`) : ''}`,
          });
        }
      }
    }
    const cursorLine = body.findIndex((b) => b.focusIndex === cursor);
    if (cursorLine < scroll) scroll = Math.max(0, cursorLine - 1);
    if (cursorLine >= scroll + rowsAvail) scroll = cursorLine - rowsAvail + 1;
    for (const b of body.slice(scroll, scroll + rowsAvail)) {
      const pointer = b.focusIndex === cursor ? paint('hint', '❯ ') : '  ';
      lines.push(pointer + b.text);
    }
    if (!body.some((b) => b.focusIndex !== undefined)) lines.push(paint('dim', '  (no matches)'));
    lines.push(message ? paint('hint', message) : '');
    out.write(`\x1b[H\x1b[2J${lines.join('\n')}`);
  };

  return new Promise((resolve) => {
    emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    out.write('\x1b[?1049h\x1b[?25l');

    const finish = (result: Update[] | undefined): void => {
      stdin.off('keypress', onKey);
      out.off('resize', render);
      stdin.setRawMode(wasRaw);
      stdin.pause();
      out.write('\x1b[?25h\x1b[?1049l');
      resolve(result);
    };

    const toggleLevel = (level: Level): void => {
      const rs = rows.filter((r) => rowLevel(r) === level);
      const on = !rs.every((r) => rowState(r) === 'all');
      for (const r of rs) for (const it of r.items) it.checked = on;
    };

    const onKey = (
      str: string | undefined,
      key: { name?: string; ctrl?: boolean; shift?: boolean; sequence?: string },
    ): void => {
      message = '';
      if (key.ctrl && key.name === 'c') return finish(undefined);
      if (confirming) {
        if (key.name === 'y' || key.name === 'return') return finish(selected());
        if (key.name === 'n' || key.name === 'escape') confirming = false;
        return render();
      }
      if (searching) {
        if (key.name === 'return') searching = false;
        else if (key.name === 'escape') {
          searching = false;
          search = '';
        } else if (key.name === 'backspace') search = search.slice(0, -1);
        else if (str && str.length === 1 && str >= ' ') search += str;
        cursor = 0;
        return render();
      }
      const f = focusables();
      const cur = f[cursor];
      switch (key.name) {
        case 'up':
        case 'k':
          cursor = Math.max(0, cursor - 1);
          break;
        case 'down':
        case 'j':
          cursor = Math.min(f.length - 1, cursor + 1);
          break;
        case 'pageup':
          cursor = Math.max(0, cursor - 10);
          break;
        case 'pagedown':
          cursor = Math.min(f.length - 1, cursor + 10);
          break;
        case 'space':
          if (cur?.item) cur.item.checked = !cur.item.checked;
          else if (cur) {
            const on = rowState(cur.row) !== 'all';
            for (const it of cur.row.items) it.checked = on;
          }
          break;
        case 'right':
        case 'l':
        case 'e':
          if (cur) cur.row.expanded = key.name === 'e' ? !cur.row.expanded : true;
          break;
        case 'left':
        case 'h':
          if (cur) {
            cur.row.expanded = false;
            cursor = focusables().findIndex((x) => x.row === cur.row && !x.item);
          }
          break;
        case 'v':
          if (cur && cur.row.versions.length > 1) setVersion(cur.row, cur.row.vi + (key.shift ? -1 : 1));
          break;
        case 'o':
          if (cur) {
            const link = changelogUrl(cur.row.meta);
            if (link) {
              openUrl(link);
              message = `Opened ${link}`;
            } else message = 'No changelog link known for this package.';
          }
          break;
        case 'a': {
          const on = !rows.every((r) => rowState(r) === 'all');
          for (const r of rows) for (const it of r.items) it.checked = on;
          break;
        }
        case 'p':
          toggleLevel('patch');
          break;
        case 'm':
          toggleLevel(key.shift ? 'major' : 'minor');
          break;
        case 'return':
          if (!selected().length) message = 'Nothing selected.';
          else confirming = true;
          break;
        case 'q':
        case 'escape':
          return finish(undefined);
        default:
          if (str === '/') {
            searching = true;
            search = '';
          } else if (str === 'M') toggleLevel('major');
          else if (str === 'V' && cur && cur.row.versions.length > 1) setVersion(cur.row, cur.row.vi - 1);
      }
      render();
    };
    stdin.on('keypress', onKey);
    out.on('resize', render);
    render();
  });
}
