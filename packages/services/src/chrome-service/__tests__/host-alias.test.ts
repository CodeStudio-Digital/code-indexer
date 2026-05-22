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
  classifyChromeServiceError,
  DEFAULT_CHROME_SERVICE_IMAGE,
  DEFAULT_CHROME_SERVICE_PORT,
  PINNED_PLAYWRIGHT_TEST_VERSION,
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

describe('Playwright client/server version coupling', () => {
  // Image tag and pinned client must agree byte-for-byte on MAJOR.MINOR.PATCH —
  // Playwright refuses to connect across mismatched versions (banner: "Looks
  // like Playwright was just updated to …"). Pin the invariant here so a
  // future bump that touches only one constant can't sneak through.
  it('image tag embeds the same version as PINNED_PLAYWRIGHT_TEST_VERSION', () => {
    expect(DEFAULT_CHROME_SERVICE_IMAGE).toContain(`:v${PINNED_PLAYWRIGHT_TEST_VERSION}-`);
  });

  it('pinned version is a strict semver MAJOR.MINOR.PATCH', () => {
    expect(PINNED_PLAYWRIGHT_TEST_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('classifyChromeServiceError', () => {
  it('classifies Playwright client/server version mismatch', () => {
    const stderr = `
      Looks like Playwright was just updated to 1.60.0.
      Please update docker image as well.
        - current: mcr.microsoft.com/playwright:v1.59.1-jammy
        - required: mcr.microsoft.com/playwright:v1.60.0-jammy
    `;
    const v = classifyChromeServiceError(stderr);
    expect(v.kind).toBe('client-server-version-mismatch');
    expect(v.hint).toMatch(/DEFAULT_CHROME_SERVICE_IMAGE/);
    expect(v.hint).toMatch(/Restart the Chrome Service/i);
  });

  it("also catches the bare 'executable doesn't exist' shape", () => {
    // The same root cause sometimes surfaces with only the bottom half
    // of the banner (Playwright trimmed the wrapper on some adapters).
    const stderr = `Executable doesn't exist at /ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-linux64/chrome-headless-shell`;
    const v = classifyChromeServiceError(stderr);
    expect(v.kind).toBe('client-server-version-mismatch');
  });

  it('classifies image-pull failures', () => {
    const v = classifyChromeServiceError('manifest not found');
    expect(v.kind).toBe('image-pull');
  });

  it('classifies network-unreachable (DNS / ECONNREFUSED)', () => {
    const v = classifyChromeServiceError('getaddrinfo ENOTFOUND host.containers.internal');
    expect(v.kind).toBe('network-unreachable');
  });

  it('falls back to "unknown" on truly opaque errors', () => {
    expect(classifyChromeServiceError('???').kind).toBe('unknown');
  });
});
