import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { ThemeSpec } from './util/color.js';
import type { DepKind, PackageManager } from './project.js';
import type { Format } from './spec.js';

export type Noted<T> = T | ({ reason?: string } & Record<string, unknown>);

export interface ConflictProjectGroup {
  name?: string;
  /** Globs matched against project directory or package name. */
  projects: string[];
}

export interface Config {
  scan?: {
    recursive?: boolean;
    depth?: number;
    include?: string[];
    exclude?: string[];
    /** Replaces the built-in ignore list (node_modules, dist, fixtures, …). */
    ignore?: string[];
    gitignore?: boolean;
    followSymlinks?: boolean;
  };
  target?: string;
  /** One format, or per dependency type: { prod: "exact", peer: "caret" } (section names work too). */
  format?: Format | Partial<Record<DepKind | string, Format>>;
  dep?: string[] | string;
  level?: string[] | string;
  filter?: string[] | string;
  reject?: string[] | string;
  project?: string[] | string;
  /** Days, or a duration like "7d", "12h", "30m". */
  cooldown?: number | string;
  /** Skip versions the current range already allows (ncu --minimal). */
  minimal?: boolean;
  /** Only versions whose peer requirements fit the project (ncu --peer). */
  peer?: boolean;
  /** Only versions whose engines.node covers the project's (ncu --enginesNode). */
  enginesNode?: boolean;
  /** Include prereleases (ncu --pre). */
  pre?: boolean;
  /** Warn when a different npm account published the target version. */
  ownerChanged?: boolean;
  install?: 'always' | 'prompt' | 'never';
  groupBy?: 'package' | 'project' | 'level';
  theme?: string | { name?: string; colors?: Partial<ThemeSpec> };
  concurrency?: number;
  /** Registry cache lifetime in minutes (default 10). */
  cacheTtl?: number;
  /** Package manager for projects without a lock file (default bun). */
  packageManager?: PackageManager;
  /** Never update these packages. Strings or { name, reason }. */
  ignore?: (string | { name: string; reason?: string })[];
  /** Keep packages inside a range: { "typescript": "~5.6.0" } or { "x": { range, reason } }. */
  pin?: Record<string, string | { range: string; reason?: string }>;
  /** Versions to never upgrade to: "vite@6.1.0", "foo@>=2 <2.1". */
  ignoreVersions?: (string | { spec: string; reason?: string })[];
  /** Packages that must move together, e.g. ["react", "react-dom"] or "@tanstack/*". */
  groups?: (string[] | { name?: string; packages: string[] })[];
  /** Use the built-in groups (react + react-dom, …). Default true. */
  builtinGroups?: boolean;
  conflicts?: {
    /** Packages allowed to differ between projects. */
    ignore?: string[];
    /** Project groups: conflicts are only reported inside a group. */
    groups?: ConflictProjectGroup[];
    align?: string;
  };
  /** Runtime versions used for engines checks and @types/node. */
  runtime?: { node?: string; bun?: string };
  /** Require a clean git status for files being written (default true). */
  gitCheck?: boolean;
  /** Query OSV for known vulnerabilities. */
  audit?: boolean;
  /** Check major-version changes in licenses. Default true. */
  licenseCheck?: boolean;
}

export const CONFIG_FILES: readonly string[] = ['depseek.config.json', '.depseekrc.json', '.depseekrc'];

export interface LoadedConfig {
  config: Config;
  file?: string;
}

export function loadConfig(cwd: string, explicit?: string): LoadedConfig {
  if (explicit) {
    const file = resolve(cwd, explicit);
    return { config: parseConfig(file), file };
  }
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILES) {
      const file = join(dir, name);
      if (existsSync(file)) return { config: parseConfig(file), file };
    }
    const pkgFile = join(dir, 'package.json');
    if (existsSync(pkgFile)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { depseek?: Config };
        if (pkg.depseek && typeof pkg.depseek === 'object') return { config: pkg.depseek, file: `${pkgFile}#depseek` };
      } catch {
        /* broken package.json is reported by the scanner */
      }
    }
    if (existsSync(join(dir, '.git'))) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { config: {} };
}

function parseConfig(file: string): Config {
  const text = readFileSync(file, 'utf8');
  try {
    // Allow // and /* */ comments.
    const stripped = text.replace(
      /("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      (m, str: string | undefined) => str ?? '',
    );
    return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1')) as Config;
  } catch (e) {
    throw new Error(`Invalid config file ${file}: ${(e as Error).message}`);
  }
}

export const CONFIG_TEMPLATE = `{
  // depseek configuration — https://github.com/ropean/depseek
  // Every CLI option can be set here; CLI flags win.

  // Version string style when writing: exact | tilde | caret | preserve | gte | x-range
  // or per dependency type:
  "format": { "prod": "exact", "dev": "exact", "peer": "caret" },
  "target": "latest",
  "dep": ["prod", "dev", "optional", "packageManager"],
  "cooldown": 0,
  "install": "prompt",
  "theme": "default",

  "scan": {
    // Replaces the built-in ignore list when set:
    // "ignore": ["node_modules", ".git", "dist", "build", "fixtures", "templates", "examples"],
    "exclude": []
  },

  // Never update these packages
  "ignore": [
    // { "name": "eslint", "reason": "flat config migration pending" }
  ],
  // Keep inside a range
  "pin": {
    // "typescript": { "range": "~5.6.0", "reason": "waiting for tooling support" }
  },
  // Never upgrade to these versions
  "ignoreVersions": [
    // { "spec": "vite@6.1.0", "reason": "broken HMR" }
  ],
  // Packages that are upgraded together to the same version
  "groups": [
    // ["@tanstack/react-query", "@tanstack/react-query-devtools"]
  ],

  "conflicts": {
    // Packages allowed to differ between projects
    "ignore": [],
    // Conflicts are only reported inside a group of projects
    "groups": [
      // { "name": "legacy", "projects": ["legacy/*"] }
    ]
  },

  "runtime": {
    // "node": "22.12.0", "bun": "1.2.0"
  },
  "gitCheck": true,
  "audit": false
}
`;
