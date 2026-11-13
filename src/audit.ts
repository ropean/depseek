import semver from 'semver';
import { mapLimit } from './util/pool.js';

export interface Vulnerability {
  id: string;
  summary?: string;
  severity?: string;
  aliases: string[];
  /** Lowest version that fixes it for the queried version, if known. */
  fixed?: string;
  url: string;
}

const OSV = 'https://api.osv.dev/v1';

interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}
interface OsvVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  database_specific?: { severity?: string };
  affected?: { package?: { name?: string; ecosystem?: string }; ranges?: { type?: string; events?: OsvEvent[] }[] }[];
}

/** Lowest `fixed` version above `version` for a package in an OSV record. */
export function fixedVersion(v: OsvVuln, name: string, version: string): string | undefined {
  const fixes: string[] = [];
  for (const a of v.affected ?? []) {
    if (a.package?.name !== name || (a.package.ecosystem && a.package.ecosystem !== 'npm')) continue;
    for (const r of a.ranges ?? []) {
      if (r.type && r.type !== 'SEMVER' && r.type !== 'ECOSYSTEM') continue;
      let introduced = '0.0.0';
      for (const e of r.events ?? []) {
        if (e.introduced !== undefined) introduced = e.introduced === '0' ? '0.0.0' : e.introduced;
        if (e.fixed && semver.valid(e.fixed) && semver.valid(introduced)) {
          if (semver.gte(version, introduced) && semver.lt(version, e.fixed)) fixes.push(e.fixed);
        }
      }
    }
  }
  return fixes.length ? semver.sort(fixes)[0] : undefined;
}

/**
 * Query OSV for known vulnerabilities of exact package versions.
 * Returns "name@version" → vulnerabilities (only affected versions are present).
 */
export async function audit(
  pkgs: { name: string; version: string }[],
  fetchFn: typeof fetch = fetch,
): Promise<Map<string, Vulnerability[]>> {
  const unique = [...new Map(pkgs.map((p) => [`${p.name}@${p.version}`, p])).values()];
  const out = new Map<string, Vulnerability[]>();
  if (!unique.length) return out;
  const hits: { key: string; name: string; version: string; ids: string[] }[] = [];
  for (let i = 0; i < unique.length; i += 500) {
    const chunk = unique.slice(i, i + 500);
    const res = await fetchFn(`${OSV}/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`OSV responded ${res.status}`);
    const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
    (data.results ?? []).forEach((r, j) => {
      const p = chunk[j]!;
      if (r.vulns?.length)
        hits.push({ key: `${p.name}@${p.version}`, name: p.name, version: p.version, ids: r.vulns.map((v) => v.id) });
    });
  }
  const ids = [...new Set(hits.flatMap((h) => h.ids))];
  const details = new Map<string, OsvVuln>();
  await mapLimit(ids, 8, async (id) => {
    try {
      const res = await fetchFn(`${OSV}/vulns/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(30_000) });
      if (res.ok) details.set(id, (await res.json()) as OsvVuln);
    } catch {
      /* summary is optional */
    }
  });
  for (const h of hits) {
    out.set(
      h.key,
      h.ids.map((id) => {
        const d = details.get(id);
        return {
          id,
          summary: d?.summary,
          severity: d?.database_specific?.severity,
          aliases: d?.aliases ?? [],
          fixed: d ? fixedVersion(d, h.name, h.version) : undefined,
          url: `https://osv.dev/vulnerability/${id}`,
        };
      }),
    );
  }
  return out;
}
