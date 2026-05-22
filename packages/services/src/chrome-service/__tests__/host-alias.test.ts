/**
 * host-alias.ts — pure URL builder helpers shared between the host
 * process and sandbox containers. The two are NOT interchangeable; this
 * test pins the distinction so a future "let's just use one" refactor
 * doesn't regress to the bug that broke force-browser on the Unity
 * ScriptReference scenario:
 *
 *     [chrome-service] connectBrowser failed: ... getaddrinfo
 *     ENOTFOUND host.containers.internal
 *
 * That error showed up because the HOST process was handed the alias
 * SANDBOX CONTAINERS use to reach the Chrome Service. The host has no
 * resolver for `host.containers.internal` — only loopback works.
 */
import { describe, it, expect } from 'vitest';
import {
  buildHostFacingWsEndpoint,
  buildHostFacingHealthUrl,
  buildLoopbackHealthUrl,
  buildLoopbackWsEndpoint,
  DEFAULT_CHROME_SERVICE_PORT,
} from '../host-alias.js';

describe('buildLoopbackWsEndpoint', () => {
  it('uses 127.0.0.1 (host-only) regardless of runtime', () => {
    // Loopback is INDEPENDENT of runtime — the host process always reaches
    // the published container port via 127.0.0.1, never via the runtime
    // gateway alias.
    expect(buildLoopbackWsEndpoint(9222)).toBe('ws://127.0.0.1:9222/');
    expect(buildLoopbackWsEndpoint(8080)).toBe('ws://127.0.0.1:8080/');
  });

  it('defaults to DEFAULT_CHROME_SERVICE_PORT when no port is passed', () => {
    expect(buildLoopbackWsEndpoint()).toBe(
      `ws://127.0.0.1:${DEFAULT_CHROME_SERVICE_PORT}/`,
    );
  });
});

describe('buildHostFacingWsEndpoint', () => {
  it('returns host.containers.internal for Podman (sandbox-only)', () => {
    expect(buildHostFacingWsEndpoint('podman', 9222)).toBe(
      'ws://host.containers.internal:9222/',
    );
  });

  it('returns host.docker.internal for Docker (sandbox-only)', () => {
    expect(buildHostFacingWsEndpoint('docker', 9222)).toBe(
      'ws://host.docker.internal:9222/',
    );
  });

  it('falls back to host.docker.internal for e2b / null runtimes', () => {
    expect(buildHostFacingWsEndpoint('e2b', 9222)).toBe(
      'ws://host.docker.internal:9222/',
    );
    expect(buildHostFacingWsEndpoint(null, 9222)).toBe(
      'ws://host.docker.internal:9222/',
    );
  });
});

describe('host vs loopback are NEVER the same string', () => {
  // Defensive: if a refactor accidentally unified these, the http-api
  // process would start failing again with `getaddrinfo ENOTFOUND` the
  // moment ChromeService is enabled. Pin the invariant in the test
  // suite so the fix can't silently regress.
  it('podman host-facing != loopback', () => {
    expect(buildHostFacingWsEndpoint('podman', 9222)).not.toBe(
      buildLoopbackWsEndpoint(9222),
    );
  });

  it('docker host-facing != loopback', () => {
    expect(buildHostFacingWsEndpoint('docker', 9222)).not.toBe(
      buildLoopbackWsEndpoint(9222),
    );
  });

  it('loopback health url uses 127.0.0.1, host-facing uses runtime alias', () => {
    expect(buildLoopbackHealthUrl(9222)).toBe('http://127.0.0.1:9222/');
    expect(buildHostFacingHealthUrl('podman', 9222)).toBe(
      'http://host.containers.internal:9222/',
    );
  });
});
