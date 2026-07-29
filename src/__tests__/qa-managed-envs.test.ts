import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
import type { CompanyOperationalSessionStore } from '@mcp/store/company-session-file-collection.js';
import { asSessionId } from '@mcp/session-storage';
import {
  SandboxManager,
  setSandboxManagerForTests,
} from '@mcp/services/sandbox/sandbox-manager.js';
import {
  setCompanySessionEnvStore,
  setQaPreviewConfig,
} from '@mcp/services/sandbox/sandbox-manager.js';
import { mintPreviewToken, parseTokenExpiry } from '@apps/http-api/server/routes/preview-auth.js';

/**
 * Verifies the QA preview-routing extension to `syncManagedEnvs`:
 *   - PLAYWRIGHT_BASE_URL_<ID> + alias are emitted only when both the
 *     boot-time config is present AND the session has the qa-playwright
 *     skill (gate function).
 *   - MCP_PREVIEW_COOKIE is minted/refreshed correctly.
 *   - Pruning removes the family when the session loses the skill.
 */

const SESSION_IDS = Array.from(
  { length: 7 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
);

let tmp: string;
let envStore: CompanySessionEnvStore;
let manager: SandboxManager;

function makeManager(): SandboxManager {
  const m = new SandboxManager({
    // Custom preview URL builder so we don't depend on any driver.
    buildPreviewUrl: (sessionId, _hostPort) => `/preview/${sessionId}/`,
  });
  setSandboxManagerForTests(m);
  return m;
}

function injectFakeSandbox(m: SandboxManager, sessionId: string): void {
  // Inject a fake sandbox into the private map. The QA env logic only
  // reads `previewUrl`, so a minimal stub is fine.
  const fake = {
    sandboxId: sessionId,
    sessionId,
    status: 'ready',
    hostPort: 5173,
    previewUrl: `/preview/${sessionId}/`,
    workdir: '/app',
    containerId: null,
    stack: 'react-ts',
    devServerPort: 5173,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (m as any).sandboxes.set(sessionId, fake);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'qa-managed-envs-'));
  const bundlePath = (sessionId: string) => join(tmp, sessionId);
  for (const sessionId of SESSION_IDS) {
    mkdirSync(bundlePath(sessionId), { recursive: true });
  }
  const operationalStore: CompanyOperationalSessionStore = {
    catalog: {
      get: (id) => {
        const sessionId = String(id);
        return SESSION_IDS.includes(sessionId)
          ? {
              session: { id: asSessionId(sessionId), kind: 'company' },
              location: { bundle_path: bundlePath(sessionId) },
            }
          : null;
      },
      list: () =>
        SESSION_IDS.map((sessionId) => ({
          session: { id: asSessionId(sessionId), kind: 'company' },
          location: { bundle_path: bundlePath(sessionId) },
        })),
    },
  };
  envStore = new CompanySessionEnvStore(operationalStore, {
    encrypt: (plaintext) => `enc:${plaintext}`,
    decrypt: (ciphertext) => ciphertext.slice(4),
  });
  setCompanySessionEnvStore(envStore);
  manager = makeManager();
});

afterEach(() => {
  setCompanySessionEnvStore(null);
  setQaPreviewConfig(null);
  setSandboxManagerForTests(null);
  rmSync(tmp, { recursive: true, force: true });
});

describe('syncManagedEnvs (QA gating)', () => {
  it('skips PLAYWRIGHT_BASE_URL family when QA config is unset', async () => {
    const sessionId = SESSION_IDS[0]!;
    injectFakeSandbox(manager, sessionId);
    // No setQaPreviewConfig — should be a no-op for QA family.
    await manager.syncManagedEnvs(sessionId);
    const env = envStore.asRecord(sessionId);
    expect(env.PREVIEW_URL_MAIN).toBeDefined();
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toBeUndefined();
    expect(env.MCP_PREVIEW_COOKIE).toBeUndefined();
  });

  it('skips QA family when session has no qa-playwright skill', async () => {
    const sessionId = SESSION_IDS[1]!;
    injectFakeSandbox(manager, sessionId);
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => false,
    });
    await manager.syncManagedEnvs(sessionId);
    const env = envStore.asRecord(sessionId);
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toBeUndefined();
    expect(env.MCP_PREVIEW_COOKIE).toBeUndefined();
  });

  it('emits PLAYWRIGHT_BASE_URL_MAIN + alias + MCP_PREVIEW_COOKIE when QA-enabled', async () => {
    const sessionId = SESSION_IDS[2]!;
    injectFakeSandbox(manager, sessionId);
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    await manager.syncManagedEnvs(sessionId);
    const env = envStore.asRecord(sessionId);
    // Phase C: the URL now points at the sandbox's loopback port via
    // the gateway alias — the http-api proxy that used to wear
    // `/preview/<id>/` is gone. `injectFakeSandbox` sets hostPort=5173.
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toMatch(
      /^http:\/\/host\.(containers|docker)\.internal:5173\/$/,
    );
    expect(env.PLAYWRIGHT_BASE_URL).toBe(env.PLAYWRIGHT_BASE_URL_MAIN);
    expect(env.MCP_PREVIEW_COOKIE).toMatch(new RegExp(`^${sessionId}\\.\\d+\\.[0-9a-f]+$`));
  });

  it('preserves an existing cookie that still has plenty of headroom', async () => {
    const sessionId = SESSION_IDS[3]!;
    injectFakeSandbox(manager, sessionId);
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    // Pre-mint a token with long TTL so refresh threshold won't trigger.
    const minted = mintPreviewToken(sessionId, 30 * 24 * 60 * 60 * 1000);
    await envStore.upsert(sessionId, 'MCP_PREVIEW_COOKIE', minted.value, true, { source: 'auto' });

    await manager.syncManagedEnvs(sessionId);
    const env = envStore.asRecord(sessionId);
    expect(env.MCP_PREVIEW_COOKIE).toBe(minted.value);
  });

  it('refreshes a cookie that is within the refresh threshold (<7 days)', async () => {
    const sessionId = SESSION_IDS[4]!;
    injectFakeSandbox(manager, sessionId);
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    // Pre-mint a token with only 1 day of TTL — under the 7d threshold.
    const stale = mintPreviewToken(sessionId, 1 * 24 * 60 * 60 * 1000);
    await envStore.upsert(sessionId, 'MCP_PREVIEW_COOKIE', stale.value, true, { source: 'auto' });

    await manager.syncManagedEnvs(sessionId);
    const env = envStore.asRecord(sessionId);
    expect(env.MCP_PREVIEW_COOKIE).not.toBe(stale.value);
    const exp = parseTokenExpiry(env.MCP_PREVIEW_COOKIE);
    expect(exp).not.toBeNull();
    expect(exp! - Date.now()).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });

  it('prunes the QA family when a previously-QA session loses the skill', async () => {
    const sessionId = SESSION_IDS[5]!;
    injectFakeSandbox(manager, sessionId);
    let qaEnabled = true;
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => qaEnabled,
    });
    await manager.syncManagedEnvs(sessionId);
    expect(envStore.asRecord(sessionId).PLAYWRIGHT_BASE_URL).toBeDefined();
    expect(envStore.asRecord(sessionId).MCP_PREVIEW_COOKIE).toBeDefined();

    qaEnabled = false;
    await manager.syncManagedEnvs(sessionId);
    const env = envStore.asRecord(sessionId);
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toBeUndefined();
    expect(env.MCP_PREVIEW_COOKIE).toBeUndefined();
    // Non-QA managed entries stay.
    expect(env.PREVIEW_URL_MAIN).toBeDefined();
    expect(env.SERVICE_URL_MAIN).toBeDefined();
  });

  it('honors MCP_QA_API_BASE override at compose time', async () => {
    const sessionId = SESSION_IDS[6]!;
    injectFakeSandbox(manager, sessionId);
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    const saved = process.env.MCP_QA_API_BASE;
    process.env.MCP_QA_API_BASE = 'https://qa.example.com';
    try {
      await manager.syncManagedEnvs(sessionId);
      const env = envStore.asRecord(sessionId);
      expect(env.PLAYWRIGHT_BASE_URL).toBe('https://qa.example.com/');
    } finally {
      if (saved === undefined) delete process.env.MCP_QA_API_BASE;
      else process.env.MCP_QA_API_BASE = saved;
    }
  });
});
