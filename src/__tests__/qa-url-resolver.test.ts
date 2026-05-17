import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveQaApiHostAlias,
  resolveQaApiBase,
  buildQaPreviewBaseUrl,
  envSafeServiceKey,
} from '@mcp/services/qa/url-resolver.js';

// ─── resolveQaApiHostAlias ────────────────────────────────────────

describe('resolveQaApiHostAlias', () => {
  it('returns host.containers.internal for podman', () => {
    expect(resolveQaApiHostAlias('podman')).toBe('host.containers.internal');
  });

  it('returns host.docker.internal for docker', () => {
    expect(resolveQaApiHostAlias('docker')).toBe('host.docker.internal');
  });

  it('falls back to host.docker.internal for e2b / null / undefined', () => {
    expect(resolveQaApiHostAlias('e2b')).toBe('host.docker.internal');
    expect(resolveQaApiHostAlias(null)).toBe('host.docker.internal');
    expect(resolveQaApiHostAlias(undefined)).toBe('host.docker.internal');
  });
});

// ─── resolveQaApiBase ─────────────────────────────────────────────

describe('resolveQaApiBase', () => {
  const savedEnv = process.env.MCP_QA_API_BASE;
  beforeEach(() => {
    delete process.env.MCP_QA_API_BASE;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MCP_QA_API_BASE;
    else process.env.MCP_QA_API_BASE = savedEnv;
  });

  it('builds podman address with httpApiPort', () => {
    expect(resolveQaApiBase({ httpApiPort: 3333, runtime: 'podman' })).toBe(
      'http://host.containers.internal:3333',
    );
  });

  it('builds docker address with httpApiPort', () => {
    expect(resolveQaApiBase({ httpApiPort: 8080, runtime: 'docker' })).toBe(
      'http://host.docker.internal:8080',
    );
  });

  it('honors explicit override parameter (takes precedence over runtime)', () => {
    expect(
      resolveQaApiBase({
        httpApiPort: 3333,
        runtime: 'podman',
        override: 'http://10.0.0.1:3333',
      }),
    ).toBe('http://10.0.0.1:3333');
  });

  it('strips trailing slash from override', () => {
    expect(
      resolveQaApiBase({
        httpApiPort: 3333,
        runtime: 'docker',
        override: 'http://10.0.0.1:3333/',
      }),
    ).toBe('http://10.0.0.1:3333');
  });

  it('honors process.env.MCP_QA_API_BASE when override param is omitted', () => {
    process.env.MCP_QA_API_BASE = 'https://qa.example.com';
    expect(resolveQaApiBase({ httpApiPort: 3333, runtime: 'podman' })).toBe(
      'https://qa.example.com',
    );
  });

  it('ignores empty/whitespace overrides', () => {
    process.env.MCP_QA_API_BASE = '   ';
    expect(resolveQaApiBase({ httpApiPort: 3333, runtime: 'podman' })).toBe(
      'http://host.containers.internal:3333',
    );
  });
});

// ─── buildQaPreviewBaseUrl ────────────────────────────────────────

describe('buildQaPreviewBaseUrl', () => {
  it('joins API base with normalised preview path', () => {
    expect(
      buildQaPreviewBaseUrl({
        httpApiPort: 3333,
        runtime: 'podman',
        previewPath: '/preview/68/',
      }),
    ).toBe('http://host.containers.internal:3333/preview/68/');
  });

  it('adds leading + trailing slash to previewPath when missing', () => {
    expect(
      buildQaPreviewBaseUrl({
        httpApiPort: 3333,
        runtime: 'podman',
        previewPath: 'preview/68',
      }),
    ).toBe('http://host.containers.internal:3333/preview/68/');
  });

  it('preserves trailing slash when already present', () => {
    expect(
      buildQaPreviewBaseUrl({
        httpApiPort: 3333,
        runtime: 'podman',
        previewPath: '/preview/68/',
      }),
    ).toBe('http://host.containers.internal:3333/preview/68/');
  });

  it('handles secondary-service preview paths', () => {
    expect(
      buildQaPreviewBaseUrl({
        httpApiPort: 3333,
        runtime: 'docker',
        previewPath: '/preview/68/_svc/api/',
      }),
    ).toBe('http://host.docker.internal:3333/preview/68/_svc/api/');
  });

  it('handles override base + secondary path', () => {
    expect(
      buildQaPreviewBaseUrl({
        httpApiPort: 3333,
        runtime: 'podman',
        previewPath: '/preview/68/_svc/api/',
        override: 'https://qa.example.com',
      }),
    ).toBe('https://qa.example.com/preview/68/_svc/api/');
  });

  it('returns root path when previewPath is empty', () => {
    expect(
      buildQaPreviewBaseUrl({
        httpApiPort: 3333,
        runtime: 'docker',
        previewPath: '',
      }),
    ).toBe('http://host.docker.internal:3333/');
  });
});

// ─── envSafeServiceKey ───────────────────────────────────────────

describe('envSafeServiceKey', () => {
  it('uppercases simple alphanumeric ids', () => {
    expect(envSafeServiceKey('api')).toBe('API');
    expect(envSafeServiceKey('worker')).toBe('WORKER');
  });

  it('replaces non-alphanumerics with underscore', () => {
    expect(envSafeServiceKey('my-service')).toBe('MY_SERVICE');
    expect(envSafeServiceKey('svc.v2')).toBe('SVC_V2');
    expect(envSafeServiceKey('a/b/c')).toBe('A_B_C');
  });

  it('matches the syncManagedEnvs convention for primary', () => {
    expect(envSafeServiceKey('main')).toBe('MAIN');
  });
});
