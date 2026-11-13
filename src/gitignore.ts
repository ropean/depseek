import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { globSource } from './util/glob.js';

interface Rule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
  basename: boolean;
}

/** Rules from one .gitignore, relative to `base` (absolute posix-ish directory). */
export interface IgnoreFile {
  base: string;
  rules: Rule[];
}

export function parseGitignore(text: string): Rule[] {
  const rules: Rule[] = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    line = line.replace(/(?<!\\)\s+$/, '');
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const src = globSource(line);
    rules.push({
      re: new RegExp(anchored ? `^${src}$` : `^${src}$`),
      negate,
      dirOnly,
      basename: !anchored,
    });
  }
  return rules;
}

export function loadIgnoreFile(dir: string): IgnoreFile | undefined {
  try {
    const text = readFileSync(join(dir, '.gitignore'), 'utf8');
    return { base: dir, rules: parseGitignore(text) };
  } catch {
    return undefined;
  }
}

/**
 * Decide whether `abs` is ignored by a stack of .gitignore files (outermost first).
 * Last matching rule wins, deeper files override shallower ones.
 */
export function isIgnored(stack: IgnoreFile[], abs: string, isDir: boolean): boolean {
  let ignored = false;
  for (const file of stack) {
    if (!abs.startsWith(file.base)) continue;
    const rel = abs.slice(file.base.length).replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) continue;
    const name = rel.slice(rel.lastIndexOf('/') + 1);
    for (const r of file.rules) {
      if (r.dirOnly && !isDir) continue;
      if (r.re.test(r.basename ? name : rel)) ignored = !r.negate;
    }
  }
  return ignored;
}
