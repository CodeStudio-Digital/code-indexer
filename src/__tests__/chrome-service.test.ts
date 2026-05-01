import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../store/db.js';
import { ChromeServiceStore } from '../store/chrome-service-store.js';
import {
  buildHostFacingWsEndpoint,
  buildHostFacingHealthUrl,
  buildLoopbackHealthUrl,
  classifyChromeServiceError,
  DEFAULT_CHROME_SERVICE_IMAGE,
  DEFAULT_CHROME_SERVICE_PORT,
} from '../core/chrome-service/host-alias.js';
import {
  fetchSidecarVersion,
  formatBrowserEndpointReply,
} from '../core/coder/tools/company/qa/qa-get-browser-endpoint.js';
import type { ChromeServiceState } from '../core/chrome-service/chrome-service.js';

// ─── ChromeServiceStore (integration) ───────────────────────────

describe('ChromeServiceStore', () => {
  let dir: string;
  let cdb: CodeIndexDB;
  let store: ChromeServiceStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-chrome-svc-'));
    cdb = new CodeIndexDB(join(dir, 'test.db'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store = new ChromeServiceStore((cdb as any).db);
  });

  afterEach(() => {
    cdb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns the seeded singleton row on first read', () => {
    const cfg = store.getConfig();
    expect(cfg.id).toBe(1);
    expect(cfg.enabled).toBe(false);
    expect(cfg.status).toBe('stopped');
    expect(cfg.image).toBe(DEFAULT_CHROME_SERVICE_IMAGE);
    expect(cfg.host_port).toBe(DEFAULT_CHROME_SERVICE_PORT);
    expect(cfg.container_id).toBeNull();
  });

  it('patch updates only the requested fields', () => {
    const next = store.patch({ enabled: true, image: 'custom:tag' });
    expect(next.enabled).toBe(true);
    expect(next.image).toBe('custom:tag');
    expect(next.host_port).toBe(DEFAULT_CHROME_SERVICE_PORT);
    expect(next.status).toBe('stopped'); // unchanged
  });

  it('patch with no fields is a no-op', () => {
    const before = store.getConfig();
    const after = store.patch({});
    // updated_at may or may not change — just check core fields stable.
    expect(after.enabled).toBe(before.enabled);
    expect(after.image).toBe(before.image);
  });

  it('host_port accepts custom port', () => {
    const next = store.patch({ host_port: 4444 });
    expect(next.host_port).toBe(4444);
  });

  it('setStatus transitions through running and back to stopped', () => {
    store.patch({ enabled: true });
    let cfg = store.setStatus({ status: 'starting' });
    expect(cfg.status).toBe('starting');
    cfg = store.setStatus({
      status: 'running',
      container_id: 'c-abc',
      started_at: '2026-04-25T10:00:00.000Z',
    });
    expect(cfg.status).toBe('running');
    expect(cfg.container_id).toBe('c-abc');
    expect(cfg.started_at).toContain('2026-04-25');
    cfg = store.setStatus({
      status: 'stopped',
      container_id: null,
      last_error: null,
    });
    expect(cfg.status).toBe('stopped');
    expect(cfg.container_id).toBeNull();
  });

  it('setStatus preserves container_id when not in payload', () => {
    store.setStatus({ status: 'running', container_id: 'c-1' });
    const next = store.setStatus({ status: 'error', last_error: 'boom' });
    expect(next.container_id).toBe('c-1');
    expect(next.last_error).toBe('boom');
  });

  it('explicit container_id: null clears the field', () => {
    store.setStatus({ status: 'running', container_id: 'c-1' });
    const next = store.setStatus({ status: 'stopped', container_id: null });
    expect(next.container_id).toBeNull();
  });
});

// ─── host-alias pure helpers ────────────────────────────────────

describe('buildHostFacingWsEndpoint', () => {
  it('uses host.containers.internal for podman', () => {
    expect(buildHostFacingWsEndpoint('podman')).toBe('ws://host.containers.internal:9222/');
  });

  it('uses host.docker.internal for docker', () => {
    expect(buildHostFacingWsEndpoint('docker')).toBe('ws://host.docker.internal:9222/');
  });

  it('falls back to docker for e2b / null', () => {
    expect(buildHostFacingWsEndpoint('e2b')).toBe('ws://host.docker.internal:9222/');
    expect(buildHostFacingWsEndpoint(null)).toBe('ws://host.docker.internal:9222/');
    expect(buildHostFacingWsEndpoint(undefined)).toBe('ws://host.docker.internal:9222/');
  });

  it('honours custom port', () => {
    expect(buildHostFacingWsEndpoint('podman', 4444)).toBe(
      'ws://host.containers.internal:4444/',
    );
  });
});

describe('buildHostFacingHealthUrl', () => {
  it('builds the run-server health path with the right alias', () => {
    // run-server returns 200 "Running" on any GET; we use root.
    expect(buildHostFacingHealthUrl('podman')).toBe('http://host.containers.internal:9222/');
    expect(buildHostFacingHealthUrl('docker', 4444)).toBe('http://host.docker.internal:4444/');
  });
});

describe('buildLoopbackHealthUrl', () => {
  it('uses 127.0.0.1 (host process probes the published port directly)', () => {
    // run-server replies on any GET path with "Running"; we use root.
    expect(buildLoopbackHealthUrl()).toBe('http://127.0.0.1:9222/');
    expect(buildLoopbackHealthUrl(4444)).toBe('http://127.0.0.1:4444/');
  });
});

// ─── classifyChromeServiceError ──────────────────────────────────

describe('classifyChromeServiceError', () => {
  it('detects image pull failures', () => {
    expect(classifyChromeServiceError('Error: manifest unknown').kind).toBe('image-pull');
    expect(classifyChromeServiceError('access denied to registry').kind).toBe('image-pull');
    expect(classifyChromeServiceError('image not found: mcr/...').kind).toBe('image-pull');
    expect(classifyChromeServiceError('unauthorized').kind).toBe('image-pull');
  });

  it('detects network unreachable', () => {
    expect(classifyChromeServiceError('connect ECONNREFUSED').kind).toBe('network-unreachable');
    expect(classifyChromeServiceError('getaddrinfo ENOTFOUND').kind).toBe('network-unreachable');
  });

  it('detects run-server crashes', () => {
    expect(classifyChromeServiceError('Cannot find module playwright').kind).toBe('run-server-crash');
  });

  it('falls back to unknown', () => {
    expect(classifyChromeServiceError('something weird').kind).toBe('unknown');
    expect(classifyChromeServiceError('').kind).toBe('unknown');
  });

  it('hint references the new admin path (not the deleted Dockerfile)', () => {
    const hint = classifyChromeServiceError('libglib').hint;
    // libglib doesn't match any specific class — fallback "unknown".
    expect(hint).not.toContain('docker/sandbox-node-e2e');
  });
});

// ─── fetchSidecarVersion ─────────────────────────────────────────

describe('fetchSidecarVersion', () => {
  it('returns ok on 200 (plain text "Running" body, not JSON)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => 'Running',
    } as unknown as Response);
    const result = await fetchSidecarVersion('http://x', fakeFetch as unknown as typeof fetch);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it('returns not-ok with status when run-server replies non-2xx', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'unavailable',
    } as unknown as Response);
    const result = await fetchSidecarVersion('http://x', fakeFetch as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('captures the error message on network failure', async () => {
    const fakeFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await fetchSidecarVersion('http://x', fakeFetch as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });
});

// ─── formatBrowserEndpointReply ──────────────────────────────────

function mkState(partial: Partial<ChromeServiceState> = {}): ChromeServiceState {
  return {
    enabled: true,
    status: 'running',
    image: DEFAULT_CHROME_SERVICE_IMAGE,
    hostPort: 9222,
    containerId: 'c-1',
    wsEndpoint: 'ws://host.containers.internal:9222/',
    loopbackHealthUrl: 'http://127.0.0.1:9222/json/version',
    lastError: null,
    startedAt: null,
    ...partial,
  };
}

describe('formatBrowserEndpointReply', () => {
  it('explains absent service singleton with admin pointer', () => {
    const out = formatBrowserEndpointReply(null, { ok: false });
    expect(out).toContain('Chrome Service is not available');
    expect(out).toContain('Do NOT try to install a browser locally');
  });

  it('describes stopped status', () => {
    const out = formatBrowserEndpointReply(mkState({ status: 'stopped' }), { ok: false });
    expect(out).toContain('disabled by the operator');
    expect(out).toContain('Admin → Chrome Service');
  });

  it('describes starting status', () => {
    const out = formatBrowserEndpointReply(mkState({ status: 'starting' }), { ok: false });
    expect(out).toContain('starting up');
  });

  it('describes error status with last_error message', () => {
    const out = formatBrowserEndpointReply(
      mkState({ status: 'error', lastError: 'pull failed: denied' }),
      { ok: false },
    );
    expect(out).toContain('errored');
    expect(out).toContain('pull failed: denied');
  });

  it('renders wsEndpoint, image, alive on healthy state', () => {
    const out = formatBrowserEndpointReply(mkState(), { ok: true });
    expect(out).toContain('wsEndpoint: ws://host.containers.internal:9222/');
    expect(out).toContain('alive:      true');
    expect(out).toContain('shared Chrome Service');
    expect(out).toContain('NEVER call');
  });

  it('shows error line when running but probe fails', () => {
    const out = formatBrowserEndpointReply(mkState(), {
      ok: false,
      error: 'connect ECONNREFUSED',
    });
    expect(out).toContain('alive:      false');
    expect(out).toContain('error:      connect ECONNREFUSED');
  });

  it('includes PLAYWRIGHT_BASE_URL_* family when env store rows are present (v4.3)', () => {
    const out = formatBrowserEndpointReply(
      mkState(),
      { ok: true },
      [
        { key: 'PLAYWRIGHT_BASE_URL', value: 'http://host.containers.internal:3333/preview/68/' },
        { key: 'PLAYWRIGHT_BASE_URL_API', value: 'http://host.containers.internal:3333/preview/68/_svc/api/' },
        { key: 'PLAYWRIGHT_BASE_URL_MAIN', value: 'http://host.containers.internal:3333/preview/68/' },
      ],
    );
    expect(out).toContain('Preview URLs');
    expect(out).toContain('PLAYWRIGHT_BASE_URL: http://host.containers.internal:3333/preview/68/');
    expect(out).toContain('PLAYWRIGHT_BASE_URL_API: http://host.containers.internal:3333/preview/68/_svc/api/');
    expect(out).toContain('Use RELATIVE goto paths');
  });

  it('omits Preview URLs section when no rows are passed', () => {
    const out = formatBrowserEndpointReply(mkState(), { ok: true });
    expect(out).not.toContain('Preview URLs');
  });
});
