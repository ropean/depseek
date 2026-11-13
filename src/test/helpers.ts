import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Create a temp directory tree from { "rel/path": content } (objects are JSON-encoded). */
export function fixture(files: Record<string, string | object>): string {
  const root = mkdtempSync(join(tmpdir(), 'depseek-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n');
  }
  return root;
}

export interface FakeVersion {
  time?: string;
  deprecated?: string;
  peerDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  license?: string;
}

/** Build a packument: versions → metadata (time defaults to long ago). */
export function packument(
  name: string,
  versions: Record<string, FakeVersion>,
  tags: Record<string, string> = {},
): object {
  const vs = Object.keys(versions);
  const stable = vs.filter((v) => !v.includes('-'));
  return {
    name,
    'dist-tags': { latest: stable[stable.length - 1] ?? vs[vs.length - 1], ...tags },
    time: Object.fromEntries(
      vs.map((v, i) => [v, versions[v]!.time ?? new Date(Date.UTC(2020, 0, 1 + i)).toISOString()]),
    ),
    versions: Object.fromEntries(vs.map((v) => [v, { name, version: v, ...versions[v] }])),
    repository: { url: `git+https://github.com/example/${name}.git` },
  };
}

/** A fetch() stand-in serving packuments by package name. */
export function fakeFetch(docs: Record<string, object>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const name = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
    const doc = docs[name];
    return new Response(doc ? JSON.stringify(doc) : '{}', { status: doc ? 200 : 404 });
  }) as typeof fetch;
}
