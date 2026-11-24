import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { isIgnored, loadIgnoreFile, type IgnoreFile } from './gitignore.js';
import type { DepEntry, DepKind, Project } from './project.js';
import { DEFAULT_IGNORE } from './scan.js';

/** Directories never searched for imports. Unlike the package.json scan, fixtures/examples DO count as usage. */
const SKIP_DIRS: ReadonlySet<string> = new Set(
  DEFAULT_IGNORE.filter((d) => !['fixtures', '__fixtures__', 'templates', 'examples'].includes(d)),
);

const STYLE_EXT = /\.(?:css|scss|sass|less|styl|pcss)$/i;
const DOC_EXT = /\.(?:txt|rst|adoc|org)$/i;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|astro|mdx?)$/i;
/** Lock files list every installed package, so they must never count as usage. */
const LOCK_FILE = /^(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?)$/;
/** Tool config that may name a package without importing it. Matched by plain text. */
const CONFIG_FILE =
  /(?:^\.?[\w.-]*rc(?:\.[\w]+)?$|\.config\.[\w]+$|^tsconfig[\w.-]*\.json$|\.toml$|^Dockerfile$|^Makefile$)/;
/** YAML is only trusted in CI locations (workflows, .gitlab-ci.yml …), not everywhere. */
const CI_YAML = /^(?:\.github\/|\.circleci\/|\.gitlab-ci\.ya?ml$|\.gitlab\/)/;

function isConfigFile(name: string, rel: string): boolean {
  if (LOCK_FILE.test(name)) return false;
  if (/\.ya?ml$/.test(name)) return CI_YAML.test(rel);
  return CONFIG_FILE.test(name);
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

/** `lodash/fp` → `lodash`, `@a/b/c` → `@a/b`; undefined for relative, absolute, `#imports`, node builtins. */
export function packageOfSpecifier(spec: string): string | undefined {
  if (!spec || /^[./#~]/.test(spec) || (/^[a-z]+:/i.test(spec) && !spec.startsWith('@'))) return undefined;
  if (BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]!)) return undefined;
  const parts = spec.split('/');
  if (spec.startsWith('@')) return parts.length >= 2 && parts[1] ? `${parts[0]}/${parts[1]}` : undefined;
  return parts[0] || undefined;
}

const SPECIFIER_PATTERNS: RegExp[] = [
  // import x from 'a' / export * from 'a' / import type {…} from 'a' (also spans lines)
  /\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"\n]+)['"]/g,
  // import 'a'
  /\bimport\s*['"]([^'"\n]+)['"]/g,
  // import('a'), require('a'), require.resolve('a'), jest.mock('a'), vi.mock('a'), import.meta.resolve('a')
  /\b(?:import|require|require\.resolve|import\.meta\.resolve|(?:jest|vi|mock)\.(?:mock|doMock|requireActual|importActual))\s*\(\s*['"]([^'"\n]+)['"]/g,
  // /// <reference types="a" />
  /<reference\s+(?:types|path)\s*=\s*['"]([^'"\n]+)['"]/g,
  // TS `import x = require('a')` is covered by require(); `declare module 'a'` augmentations:
  /\bdeclare\s+module\s+['"]([^'"\n]+)['"]/g,
];

const STYLE_IMPORT = /@(?:import|plugin|use|forward|source|config)\s+(?:url\(\s*)?['"]([^'"\n]+)['"]/g;

/** Package names pulled in by a stylesheet: `@import "pkg/x.css"`, `@use "~pkg"`, Tailwind `@plugin "pkg"`. */
export function styleImports(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(STYLE_IMPORT)) {
    const pkg = packageOfSpecifier(m[1]!.replace(/^~/, ''));
    if (pkg) out.add(pkg);
  }
  return out;
}

/** Package names imported by one source file. */
export function importedPackages(source: string): Set<string> {
  const out = new Set<string>();
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    for (const m of source.matchAll(re)) {
      const pkg = packageOfSpecifier(m[1]!);
      if (pkg) out.add(pkg);
    }
  }
  return out;
}

/** True when `name` appears in `text` as a whole token (so `vite` does not match `vitest`). */
export function mentions(text: string, name: string): boolean {
  const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return new RegExp(`(?<![\\w@.-])${esc}(?![\\w-])`).test(text);
}

/** `@types/node` → `node`, `@types/babel__core` → `@babel/core`. */
export function typesTarget(name: string): string | undefined {
  if (!name.startsWith('@types/')) return undefined;
  const base = name.slice('@types/'.length);
  return base.includes('__') ? `@${base.replace('__', '/')}` : base;
}

interface Files {
  code: string[];
  style: string[];
  doc: string[];
  config: string[];
}

async function collectFiles(
  project: Project,
  exclude: (rel: string) => boolean,
  useGitignore: boolean,
): Promise<Files> {
  const files: Files = { code: [], style: [], doc: [], config: [] };
  // Nested package.json directories are their own projects (workspace members, sub-packages).
  const walk = async (dir: string, rel: string, ignores: IgnoreFile[]): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const own = useGitignore ? loadIgnoreFile(dir) : undefined;
    const stack = own ? [...ignores, own] : ignores;
    for (const e of entries) {
      const abs = join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || exclude(r)) continue;
        if (useGitignore && isIgnored(stack, abs, true)) continue;
        if (existsSync(join(abs, 'package.json'))) continue;
        await walk(abs, r, stack);
      } else if (e.isFile()) {
        if (exclude(r) || (useGitignore && isIgnored(stack, abs, false))) continue;
        if (CODE_EXT.test(e.name)) files.code.push(abs);
        else if (STYLE_EXT.test(e.name)) files.style.push(abs);
        else if (DOC_EXT.test(e.name)) files.doc.push(abs);
        else if (isConfigFile(e.name, r)) files.config.push(abs);
      }
    }
  };
  await walk(project.dir, '', []);
  return files;
}

/** Bin names a dependency provides, read from node_modules when installed (so `tsc` counts as typescript). */
function installedBins(project: Project, name: string): string[] {
  const dirs = [project.dir, project.workspaceRoot?.dir].filter((d): d is string => Boolean(d));
  for (const d of dirs) {
    try {
      const json = JSON.parse(readFileSync(join(d, 'node_modules', name, 'package.json'), 'utf8')) as {
        bin?: string | Record<string, string>;
      };
      if (typeof json.bin === 'string') return [name.split('/').pop()!];
      if (json.bin) return Object.keys(json.bin);
      return [];
    } catch {
      // not installed here
    }
  }
  return [];
}

export interface UnusedDep {
  entry: DepEntry;
  /** Why it is considered unused. */
  reason: 'not-imported' | 'types-of-unused';
  /**
   * The name still appears in comments, docs (README, CLAUDE.md …) or other prose. Lower confidence: it may be
   * loaded indirectly (injected, built-name strings, CLIs). `false` means nothing in the project mentions it.
   */
  mentioned: boolean;
}

export interface UnusedResult {
  project: Project;
  unused: UnusedDep[];
  /** Number of source files searched. */
  files: number;
}

export interface UnusedOptions {
  kinds?: ReadonlySet<DepKind>;
  /** Dependency names never reported. */
  ignore?: (name: string) => boolean;
  /** Relative posix paths (from the project dir) that are not searched. */
  exclude?: (rel: string) => boolean;
  gitignore?: boolean;
}

const DEFAULT_KINDS: ReadonlySet<DepKind> = new Set<DepKind>(['prod', 'dev', 'optional']);

/** Dependencies of `project` that nothing in its own source tree, scripts or tool config refers to. */
export async function findUnused(project: Project, opts: UnusedOptions = {}): Promise<UnusedResult> {
  const kinds = opts.kinds ?? DEFAULT_KINDS;
  const files = await collectFiles(project, opts.exclude ?? (() => false), opts.gitignore !== false);

  const imported = new Set<string>();
  const texts: string[] = [];
  /** Everything that is not a usage but may still talk about a package: comments, docs, stylesheets. */
  const prose: string[] = [];
  for (const f of files.code) {
    let src: string;
    try {
      src = await readFile(f, 'utf8');
    } catch {
      continue;
    }
    for (const n of importedPackages(src)) imported.add(n);
    prose.push(src);
    // Code files also double as config (vite.config.ts, eslint.config.js …): plain-text mentions count too.
    if (/(?:^|[\\/])(?:[\w.-]*\.config\.[\w]+|\.?[\w.-]*rc(?:\.[\w]+)?)$/.test(f)) texts.push(src);
  }
  for (const f of files.style) {
    try {
      const css = await readFile(f, 'utf8');
      for (const n of styleImports(css)) imported.add(n);
      prose.push(css);
    } catch {
      // unreadable: ignore
    }
  }
  for (const f of files.doc) {
    try {
      prose.push(await readFile(f, 'utf8'));
    } catch {
      // unreadable: ignore
    }
  }
  for (const f of files.config) {
    try {
      texts.push(await readFile(f, 'utf8'));
    } catch {
      // unreadable: ignore
    }
  }

  // package.json outside the dependency sections: scripts, bin, eslintConfig, babel, jest, …
  const rest: Record<string, unknown> = { ...project.json };
  for (const k of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
    'overrides',
    'resolutions',
    'packageManager',
    'devEngines',
    'pnpm',
  ])
    delete rest[k];
  texts.push(JSON.stringify(rest));
  const corpus = texts.join('\n');
  const proseText = prose.join('\n');

  const declared = new Map<string, DepEntry>();
  for (const e of project.deps) if (kinds.has(e.kind) && e.kind !== 'peer') declared.set(e.name, e);
  const allDeclared = new Set(project.deps.filter((e) => e.kind !== 'overrides').map((e) => e.name));

  const used = (e: DepEntry): boolean =>
    imported.has(e.name) || mentions(corpus, e.name) || installedBins(project, e.name).some((b) => mentions(corpus, b));

  const unused: UnusedDep[] = [];
  const unusedNames = new Set<string>();
  for (const e of declared.values()) {
    if (opts.ignore?.(e.name)) continue;
    if (e.name.startsWith('@types/')) continue; // decided below, once the base packages are known
    if (!used(e)) {
      unused.push({ entry: e, reason: 'not-imported', mentioned: mentions(proseText, e.name) });
      unusedNames.add(e.name);
    }
  }
  for (const e of declared.values()) {
    if (opts.ignore?.(e.name)) continue;
    const target = typesTarget(e.name);
    if (!target) continue;
    // @types/node and other packages without a declared base package can't be judged: keep them.
    if (!allDeclared.has(target)) continue;
    if (unusedNames.has(target) && !imported.has(e.name))
      unused.push({ entry: e, reason: 'types-of-unused', mentioned: mentions(proseText, target) });
  }
  return { project, unused: unused.sort((a, b) => a.entry.name.localeCompare(b.entry.name)), files: files.code.length };
}
