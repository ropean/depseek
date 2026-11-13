import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mapLimit } from './util/pool.js';

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';

export interface RegistryAuth {
  /** "//host/path/" prefix the credential applies to. */
  prefix: string;
  token?: string;
  /** base64 "user:pass" */
  basic?: string;
}

export interface RegistryConfig {
  registry: string;
  scopes: Record<string, string>;
  auth: RegistryAuth[];
}

export interface VersionMeta {
  deprecated?: string;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  engines?: Record<string, string>;
  license?: string;
}

export interface PackageMeta {
  name: string;
  distTags: Record<string, string>;
  versions: Record<string, VersionMeta>;
  time: Record<string, string>;
  repository?: string;
  homepage?: string;
}

const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`);
const expandEnv = (s: string, env: NodeJS.ProcessEnv): string =>
  s.replace(
    /\$\{([^}]+)\}|\$([A-Z_][A-Z0-9_]*)/gi,
    (_, a: string | undefined, b: string | undefined) => env[(a ?? b)!] ?? '',
  );

export function parseNpmrc(text: string, cfg: RegistryConfig, env: NodeJS.ProcessEnv = process.env): void {
  const users = new Map<string, { username?: string; password?: string }>();
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith(';')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const value = expandEnv(
      t
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, ''),
      env,
    );
    if (key === 'registry') cfg.registry = withSlash(value);
    else if (/^@[^:]+:registry$/.test(key)) cfg.scopes[key.slice(0, key.indexOf(':'))] = withSlash(value);
    else if (key.startsWith('//')) {
      const m = /^(\/\/.+?):(_authToken|_auth|username|_password)$/.exec(key);
      if (!m) continue;
      const prefix = withSlash(m[1]!);
      if (m[2] === '_authToken') cfg.auth.push({ prefix, token: value });
      else if (m[2] === '_auth') cfg.auth.push({ prefix, basic: value });
      else {
        const u = users.get(prefix) ?? {};
        if (m[2] === 'username') u.username = value;
        else u.password = Buffer.from(value, 'base64').toString('utf8');
        users.set(prefix, u);
      }
    }
  }
  for (const [prefix, u] of users) {
    if (u.username && u.password)
      cfg.auth.push({ prefix, basic: Buffer.from(`${u.username}:${u.password}`).toString('base64') });
  }
}

/** Parse the registry bits of bunfig.toml: [install] registry and [install.scopes]. */
export function parseBunfig(text: string, cfg: RegistryConfig, env: NodeJS.ProcessEnv = process.env): void {
  let section = '';
  const val = (raw: string): { url?: string; token?: string } => {
    raw = raw.trim();
    if (raw.startsWith('"') || raw.startsWith("'")) return { url: raw.slice(1, -1) };
    const tbl: Record<string, string> = {};
    for (const m of raw.matchAll(/(\w+)\s*=\s*["']([^"']*)["']/g)) tbl[m[1]!] = m[2]!;
    return { url: tbl.url, token: tbl.token };
  };
  const register = (scope: string | undefined, v: { url?: string; token?: string }): void => {
    if (!v.url) return;
    const url = withSlash(expandEnv(v.url, env));
    if (scope) cfg.scopes[scope.startsWith('@') ? scope : `@${scope}`] = url;
    else cfg.registry = url;
    if (v.token) cfg.auth.push({ prefix: url.replace(/^https?:/, ''), token: expandEnv(v.token, env) });
  };
  for (const line of text.split(/\r?\n/)) {
    const t = line.replace(/#.*$/, '').trim();
    if (!t) continue;
    const sec = /^\[([^\]]+)\]$/.exec(t);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const kv = /^("?[@\w.-]+"?)\s*=\s*(.+)$/.exec(t);
    if (!kv) continue;
    const key = kv[1]!.replace(/"/g, '');
    if (section === 'install' && key === 'registry') register(undefined, val(kv[2]!));
    if (section === 'install.scopes') register(key, val(kv[2]!));
  }
}

/** Collect registry settings: ~/.npmrc, then .npmrc / bunfig.toml from the git root down to `dir`. */
export function loadRegistryConfig(dir: string, env: NodeJS.ProcessEnv = process.env): RegistryConfig {
  const cfg: RegistryConfig = { registry: DEFAULT_REGISTRY, scopes: {}, auth: [] };
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(f, 'utf8');
    } catch {
      return undefined;
    }
  };
  const home = homedir();
  const userRc = env.NPM_CONFIG_USERCONFIG ?? env.npm_config_userconfig ?? join(home, '.npmrc');
  const u = read(userRc);
  if (u) parseNpmrc(u, cfg, env);
  const globalBun =
    read(join(env.XDG_CONFIG_HOME ?? join(home, '.config'), '.bunfig.toml')) ?? read(join(home, '.bunfig.toml'));
  if (globalBun) parseBunfig(globalBun, cfg, env);

  const chain: string[] = [];
  let d = dir;
  for (;;) {
    chain.push(d);
    if (existsSync(join(d, '.git')) || d === home) break;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  for (const c of chain.reverse()) {
    if (c === home) continue;
    const rc = read(join(c, '.npmrc'));
    if (rc) parseNpmrc(rc, cfg, env);
    const bun = read(join(c, 'bunfig.toml'));
    if (bun) parseBunfig(bun, cfg, env);
  }
  const envReg = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (envReg) cfg.registry = withSlash(envReg);
  return cfg;
}

export function registryFor(name: string, cfg: RegistryConfig): string {
  if (name.startsWith('@')) {
    const scope = name.slice(0, name.indexOf('/'));
    if (cfg.scopes[scope]) return cfg.scopes[scope];
  }
  return cfg.registry;
}

export function authHeader(url: string, cfg: RegistryConfig): string | undefined {
  const bare = url.replace(/^https?:/, '');
  let best: RegistryAuth | undefined;
  for (const a of cfg.auth) if (bare.startsWith(a.prefix) && (!best || a.prefix.length > best.prefix.length)) best = a;
  if (!best) return undefined;
  return best.token ? `Bearer ${best.token}` : `Basic ${best.basic}`;
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.DEPSEEK_CACHE_DIR) return env.DEPSEEK_CACHE_DIR;
  const base =
    env.XDG_CACHE_HOME ??
    (process.platform === 'win32' && env.LOCALAPPDATA ? env.LOCALAPPDATA : join(homedir(), '.cache'));
  return join(base, 'depseek');
}

function trim(doc: Record<string, unknown>): PackageMeta {
  const versions: Record<string, VersionMeta> = {};
  const raw = (doc.versions ?? {}) as Record<string, Record<string, unknown>>;
  for (const [v, m] of Object.entries(raw)) {
    const vm: VersionMeta = {};
    if (typeof m.deprecated === 'string' && m.deprecated) vm.deprecated = m.deprecated;
    if (m.peerDependencies) vm.peerDependencies = m.peerDependencies as Record<string, string>;
    if (m.peerDependenciesMeta) vm.peerDependenciesMeta = m.peerDependenciesMeta as VersionMeta['peerDependenciesMeta'];
    if (m.engines && typeof m.engines === 'object' && !Array.isArray(m.engines))
      vm.engines = m.engines as Record<string, string>;
    const lic = m.license;
    if (typeof lic === 'string') vm.license = lic;
    else if (lic && typeof lic === 'object' && typeof (lic as { type?: unknown }).type === 'string')
      vm.license = (lic as { type: string }).type;
    versions[v] = vm;
  }
  const repo = doc.repository;
  return {
    name: String(doc.name),
    distTags: (doc['dist-tags'] ?? {}) as Record<string, string>,
    versions,
    time: (doc.time ?? {}) as Record<string, string>,
    repository:
      typeof repo === 'string'
        ? repo
        : typeof (repo as { url?: unknown })?.url === 'string'
          ? (repo as { url: string }).url
          : undefined,
    homepage: typeof doc.homepage === 'string' ? doc.homepage : undefined,
  };
}

export interface RegistryClientOptions {
  config: RegistryConfig;
  concurrency?: number;
  /** Cache lifetime in minutes; 0 disables reading the cache. */
  cacheTtl?: number;
  useCache?: boolean;
  fetch?: typeof fetch;
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class RegistryClient {
  private readonly memo = new Map<string, Promise<PackageMeta>>();
  private readonly dir: string;
  constructor(private readonly opts: RegistryClientOptions) {
    this.dir = join(cacheDir(), 'packuments');
  }

  private cacheFile(url: string): string {
    return join(this.dir, `${createHash('sha1').update(url).digest('hex')}.json`);
  }

  get(name: string): Promise<PackageMeta> {
    let p = this.memo.get(name);
    if (!p) {
      p = this.load(name);
      this.memo.set(name, p);
    }
    return p;
  }

  /** Fetch many packages at once (deduplicated, limited concurrency). Failures are returned as errors. */
  async getMany(
    names: Iterable<string>,
    onProgress?: (done: number, total: number) => void,
  ): Promise<Map<string, PackageMeta | RegistryError>> {
    const unique = [...new Set(names)];
    const out = new Map<string, PackageMeta | RegistryError>();
    let done = 0;
    await mapLimit(unique, this.opts.concurrency ?? 16, async (name) => {
      try {
        out.set(name, await this.get(name));
      } catch (e) {
        out.set(name, e instanceof RegistryError ? e : new RegistryError((e as Error).message));
      }
      onProgress?.(++done, unique.length);
    });
    return out;
  }

  private async load(name: string): Promise<PackageMeta> {
    const registry = registryFor(name, this.opts.config);
    const url = registry + name.replace('/', '%2f');
    const file = this.cacheFile(url);
    const ttl = (this.opts.cacheTtl ?? 10) * 60_000;
    if (this.opts.useCache !== false && ttl > 0 && existsSync(file)) {
      try {
        const cached = JSON.parse(readFileSync(file, 'utf8')) as { at: number; data: PackageMeta };
        if (Date.now() - cached.at < ttl) return cached.data;
      } catch {
        /* corrupt cache → refetch */
      }
    }
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'depseek' };
    const auth = authHeader(url, this.opts.config);
    if (auth) headers.authorization = auth;
    const doFetch = this.opts.fetch ?? fetch;
    let res: Response | undefined;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        res = await doFetch(url, { headers, signal: AbortSignal.timeout(60_000) });
        if (res.status < 500 && res.status !== 429) break;
      } catch (e) {
        lastErr = e;
        res = undefined;
      }
      await new Promise((r) => setTimeout(r, 300 * 2 ** attempt));
    }
    if (!res) throw new RegistryError(`request failed: ${(lastErr as Error)?.message ?? 'unknown error'}`);
    if (res.status === 404) throw new RegistryError('not found in registry', 404);
    if (res.status === 401 || res.status === 403)
      throw new RegistryError(`unauthorized (${res.status}) — check .npmrc token`, res.status);
    if (!res.ok) throw new RegistryError(`registry responded ${res.status}`, res.status);
    const data = trim((await res.json()) as Record<string, unknown>);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ at: Date.now(), data }));
    } catch {
      /* cache is best effort */
    }
    return data;
  }
}

/** Turn a repository field into a browsable https URL (GitHub/GitLab/Bitbucket). */
export function repoUrl(repo: string | undefined): string | undefined {
  if (!repo) return undefined;
  let r = repo.trim();
  const short = /^(github|gitlab|bitbucket):(.+)$/.exec(r);
  if (short) r = `https://${short[1]}.${short[1] === 'bitbucket' ? 'org' : 'com'}/${short[2]}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(r)) r = `https://github.com/${r}`;
  r = r
    .replace(/^git\+/, '')
    .replace(/^git:\/\//, 'https://')
    .replace(/^ssh:\/\/git@/, 'https://')
    .replace(/^git@([^:]+):/, 'https://$1/')
    .replace(/\.git(#.*)?$/, '')
    .replace(/#.*$/, '');
  return /^https?:\/\//.test(r) ? r : undefined;
}

/** Best guess at a changelog / releases page for a package. */
export function changelogUrl(meta: PackageMeta | undefined, version?: string): string | undefined {
  const repo = repoUrl(meta?.repository);
  if (repo && /github\.com/.test(repo)) return version ? `${repo}/releases` : `${repo}/releases`;
  return repo ?? meta?.homepage;
}
