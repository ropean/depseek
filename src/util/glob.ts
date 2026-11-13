/**
 * Minimal glob → RegExp conversion supporting `**`, `*`, `?`, `[...]` and `{a,b}`.
 * Paths are always posix-style.
 */

function escapeRe(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}

export function globSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) re += '\\[';
      else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if (ch === '{') {
      let depth = 0;
      let end = -1;
      for (let j = i; j < glob.length; j++) {
        if (glob[j] === '{') depth++;
        if (glob[j] === '}' && --depth === 0) {
          end = j;
          break;
        }
      }
      if (end === -1) re += '\\{';
      else {
        re += `(?:${splitTopLevel(glob.slice(i + 1, end))
          .map(globSource)
          .join('|')})`;
        i = end;
      }
    } else if (ch === '\\' && i + 1 < glob.length) {
      re += escapeRe(glob[++i]!);
    } else re += escapeRe(ch);
  }
  return re;
}

export function globToRegExp(glob: string, flags = ''): RegExp {
  return new RegExp(`^${globSource(glob)}$`, flags);
}

export const hasMagic = (s: string): boolean => /[*?[{]/.test(s);

/**
 * Matcher for path globs used by --include / --exclude. A pattern without a slash
 * matches any single path segment (like .gitignore); otherwise it is matched against
 * the whole relative path.
 */
export function pathMatcher(patterns: string[]): (rel: string) => boolean {
  const tests = patterns.map((p) => {
    const clean = p.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!clean.includes('/')) {
      const re = globToRegExp(clean);
      return (rel: string) => rel.split('/').some((seg) => re.test(seg));
    }
    const re = globToRegExp(clean.replace(/^\//, ''));
    return (rel: string) => re.test(rel);
  });
  return (rel) => tests.some((t) => t(rel));
}

/**
 * Matcher for package names (-f / -x), ncu-compatible: comma/space separated list,
 * globs (`@types/*`) and `/regex/flags`.
 */
export function nameMatcher(input: string | string[] | undefined): ((name: string) => boolean) | undefined {
  if (input === undefined) return undefined;
  const list = (Array.isArray(input) ? input : [input]).flatMap((s) => {
    const t = s.trim();
    if (/^\/.+\/[a-z]*$/.test(t)) return [t];
    return t.split(/[\s,]+/).filter(Boolean);
  });
  if (!list.length) return undefined;
  const tests = list.map((p) => {
    const m = /^\/(.+)\/([a-z]*)$/.exec(p);
    if (m) {
      const re = new RegExp(m[1]!, m[2]);
      return (n: string) => re.test(n);
    }
    if (hasMagic(p)) {
      const re = new RegExp(`^${globSource(p).replace(/\[\^\/\]\*/g, '.*')}$`);
      return (n: string) => re.test(n);
    }
    return (n: string) => n === p;
  });
  return (name) => tests.some((t) => t(name));
}
