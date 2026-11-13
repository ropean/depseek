import { describe, expect, it } from 'vitest';
import {
  authHeader,
  DEFAULT_REGISTRY,
  parseBunfig,
  parseNpmrc,
  registryFor,
  repoUrl,
  type RegistryConfig,
} from './registry.js';

const empty = (): RegistryConfig => ({ registry: DEFAULT_REGISTRY, scopes: {}, auth: [] });

describe('registry config', () => {
  it('parses .npmrc registries, scopes and tokens with env expansion', () => {
    const cfg = empty();
    parseNpmrc(
      [
        'registry=https://mirror.test/npm',
        '@acme:registry=https://npm.acme.test/',
        '//npm.acme.test/:_authToken=${ACME_TOKEN}',
        '; comment',
      ].join('\n'),
      cfg,
      { ACME_TOKEN: 'secret' },
    );
    expect(registryFor('react', cfg)).toBe('https://mirror.test/npm/');
    expect(registryFor('@acme/ui', cfg)).toBe('https://npm.acme.test/');
    expect(authHeader('https://npm.acme.test/@acme%2fui', cfg)).toBe('Bearer secret');
    expect(authHeader('https://mirror.test/npm/react', cfg)).toBeUndefined();
  });

  it('parses bunfig.toml install registries', () => {
    const cfg = empty();
    parseBunfig(
      [
        '[install]',
        'registry = "https://bun-mirror.test/"',
        '',
        '[install.scopes]',
        'myorg = { token = "$TOKEN", url = "https://npm.myorg.test/" }',
        '"@other" = "https://other.test/"',
      ].join('\n'),
      cfg,
      { TOKEN: 't0k' },
    );
    expect(cfg.registry).toBe('https://bun-mirror.test/');
    expect(cfg.scopes).toEqual({ '@myorg': 'https://npm.myorg.test/', '@other': 'https://other.test/' });
    expect(authHeader('https://npm.myorg.test/@myorg%2fx', cfg)).toBe('Bearer t0k');
  });

  it('normalises repository urls', () => {
    expect(repoUrl('git+https://github.com/facebook/react.git')).toBe('https://github.com/facebook/react');
    expect(repoUrl('github:vitejs/vite')).toBe('https://github.com/vitejs/vite');
    expect(repoUrl('git@github.com:a/b.git')).toBe('https://github.com/a/b');
    expect(repoUrl('a/b')).toBe('https://github.com/a/b');
  });
});
