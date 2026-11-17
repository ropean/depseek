import { describe, expect, it } from 'vitest';
import { githubLatestRepo, isExternalSource, parseLsJson } from './commands/global.js';

describe('global sources', () => {
  it('separates URL / git installs from registry packages', () => {
    const gh = 'https://github.com/ropean/depseek/releases/latest/download/depseek.tgz';
    const out = parseLsJson(
      JSON.stringify([
        {
          dependencies: {
            a: { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
            b: { version: '0.0.1', resolved: gh },
            c: { version: '2.0.0', resolved: 'link:../c' },
          },
        },
      ]),
    );
    expect(out.deps).toEqual({ a: '1.0.0' });
    expect(out.external).toEqual({ b: { version: '0.0.1', source: gh } });
    expect(out.linked).toEqual(['c']);
    expect(githubLatestRepo(gh)).toBe('ropean/depseek');
    expect(isExternalSource('git+ssh://git@github.com/o/r.git#abc')).toBe(true);
    expect(isExternalSource(undefined)).toBe(false);
  });
});
