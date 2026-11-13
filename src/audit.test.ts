import { describe, expect, it } from 'vitest';
import { audit, fixedVersion } from './audit.js';

const vuln = {
  id: 'GHSA-xxxx',
  summary: 'Prototype pollution',
  aliases: ['CVE-2024-0001'],
  database_specific: { severity: 'HIGH' },
  affected: [
    {
      package: { name: 'lib', ecosystem: 'npm' },
      ranges: [
        {
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '1.2.0' }, { introduced: '2.0.0' }, { fixed: '2.0.3' }],
        },
      ],
    },
  ],
};

describe('audit', () => {
  it('finds the fixing version for the affected line', () => {
    expect(fixedVersion(vuln, 'lib', '1.1.0')).toBe('1.2.0');
    expect(fixedVersion(vuln, 'lib', '2.0.1')).toBe('2.0.3');
    expect(fixedVersion(vuln, 'lib', '1.5.0')).toBeUndefined();
    expect(fixedVersion(vuln, 'other', '1.1.0')).toBeUndefined();
  });

  it('queries OSV in batch and resolves details', async () => {
    const calls: string[] = [];
    const fake = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      if (String(url).endsWith('/querybatch')) {
        const body = JSON.parse(String(init!.body)) as { queries: { version: string }[] };
        return Response.json({
          results: body.queries.map((q) => (q.version === '1.1.0' ? { vulns: [{ id: 'GHSA-xxxx' }] } : {})),
        });
      }
      return Response.json(vuln);
    }) as typeof fetch;
    const r = await audit(
      [
        { name: 'lib', version: '1.1.0' },
        { name: 'lib', version: '1.1.0' },
        { name: 'lib', version: '1.5.0' },
      ],
      fake,
    );
    expect([...r.keys()]).toEqual(['lib@1.1.0']);
    expect(r.get('lib@1.1.0')![0]).toMatchObject({ id: 'GHSA-xxxx', fixed: '1.2.0', severity: 'HIGH' });
    expect(calls.filter((c) => c.endsWith('/querybatch'))).toHaveLength(1);
  });
});
