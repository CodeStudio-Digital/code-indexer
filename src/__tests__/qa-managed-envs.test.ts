import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanySessionEnvStore } from '@mcp/store/company-session-env-store.js';
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

function seedSession(db: CodeIndexDB, id: number, configJson: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db as any).db
    .prepare(
      `INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', ?)`,
    )
    .run(id, `s${id}`, configJson);
}

const QA_CONFIG = JSON.stringify({
  role_assignments: [{ role: 'qa', skills: ['qa-playwright'] }],
});
const NO_QA_CONFIG = JSON.stringify({
  role_assignments: [{ role: 'frontend', skills: ['react'] }],
});

let tmp: string;
let db: CodeIndexDB;
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
  db = new CodeIndexDB(join(tmp, 'idx.db'));
  envStore = new CompanySessionEnvStore(db.raw());
  setCompanySessionEnvStore(envStore);
  manager = makeManager();
});

afterEach(() => {
  setCompanySessionEnvStore(null);
  setQaPreviewConfig(null);
  setSandboxManagerForTests(null);
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('syncManagedEnvs (QA gating)', () => {
  it('skips PLAYWRIGHT_BASE_URL family when QA config is unset', () => {
    seedSession(db, 1, QA_CONFIG);
    injectFakeSandbox(manager, '1');
    // No setQaPreviewConfig — should be a no-op for QA family.
    manager.syncManagedEnvs('1');
    const env = envStore.asRecord(1);
    expect(env.PREVIEW_URL_MAIN).toBeDefined();
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toBeUndefined();
    expect(env.MCP_PREVIEW_COOKIE).toBeUndefined();
  });

  it('skips QA family when session has no qa-playwright skill', () => {
    seedSession(db, 2, NO_QA_CONFIG);
    injectFakeSandbox(manager, '2');
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => false,
    });
    manager.syncManagedEnvs('2');
    const env = envStore.asRecord(2);
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toBeUndefined();
    expect(env.MCP_PREVIEW_COOKIE).toBeUndefined();
  });

  it('emits PLAYWRIGHT_BASE_URL_MAIN + alias + MCP_PREVIEW_COOKIE when QA-enabled', () => {
    seedSession(db, 3, QA_CONFIG);
    injectFakeSandbox(manager, '3');
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    manager.syncManagedEnvs('3');
    const env = envStore.asRecord(3);
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toMatch(
      /^http:\/\/host\.(containers|docker)\.internal:3333\/preview\/3\/$/,
    );
    expect(env.PLAYWRIGHT_BASE_URL).toBe(env.PLAYWRIGHT_BASE_URL_MAIN);
    expect(env.MCP_PREVIEW_COOKIE).toMatch(/^3\.\d+\.[0-9a-f]+$/);
  });

  it('preserves an existing cookie that still has plenty of headroom', () => {
    seedSession(db, 4, QA_CONFIG);
    injectFakeSandbox(manager, '4');
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    // Pre-mint a token with long TTL so refresh threshold won't trigger.
    const minted = mintPreviewToken('4', 30 * 24 * 60 * 60 * 1000);
    envStore.upsert(4, 'MCP_PREVIEW_COOKIE', minted.value, true, { source: 'auto' });

    manager.syncManagedEnvs('4');
    const env = envStore.asRecord(4);
    expect(env.MCP_PREVIEW_COOKIE).toBe(minted.value);
  });

  it('refreshes a cookie that is within the refresh threshold (<7 days)', () => {
    seedSession(db, 5, QA_CONFIG);
    injectFakeSandbox(manager, '5');
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    // Pre-mint a token with only 1 day of TTL — under the 7d threshold.
    const stale = mintPreviewToken('5', 1 * 24 * 60 * 60 * 1000);
    envStore.upsert(5, 'MCP_PREVIEW_COOKIE', stale.value, true, { source: 'auto' });

    manager.syncManagedEnvs('5');
    const env = envStore.asRecord(5);
    expect(env.MCP_PREVIEW_COOKIE).not.toBe(stale.value);
    const exp = parseTokenExpiry(env.MCP_PREVIEW_COOKIE);
    expect(exp).not.toBeNull();
    expect(exp! - Date.now()).toBeGreaterThan(7 * 24 * 60 * 60 * 1000);
  });

  it('prunes the QA family when a previously-QA session loses the skill', () => {
    seedSession(db, 6, QA_CONFIG);
    injectFakeSandbox(manager, '6');
    let qaEnabled = true;
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => qaEnabled,
    });
    manager.syncManagedEnvs('6');
    expect(envStore.asRecord(6).PLAYWRIGHT_BASE_URL).toBeDefined();
    expect(envStore.asRecord(6).MCP_PREVIEW_COOKIE).toBeDefined();

    qaEnabled = false;
    manager.syncManagedEnvs('6');
    const env = envStore.asRecord(6);
    expect(env.PLAYWRIGHT_BASE_URL).toBeUndefined();
    expect(env.PLAYWRIGHT_BASE_URL_MAIN).toBeUndefined();
    expect(env.MCP_PREVIEW_COOKIE).toBeUndefined();
    // Non-QA managed entries stay.
    expect(env.PREVIEW_URL_MAIN).toBeDefined();
    expect(env.SERVICE_URL_MAIN).toBeDefined();
  });

  it('honors MCP_QA_API_BASE override at compose time', () => {
    seedSession(db, 7, QA_CONFIG);
    injectFakeSandbox(manager, '7');
    setQaPreviewConfig({
      httpApiPort: 3333,
      hasQaPlaywrightSkill: () => true,
    });
    const saved = process.env.MCP_QA_API_BASE;
    process.env.MCP_QA_API_BASE = 'https://qa.example.com';
    try {
      manager.syncManagedEnvs('7');
      const env = envStore.asRecord(7);
      expect(env.PLAYWRIGHT_BASE_URL).toBe('https://qa.example.com/preview/7/');
    } finally {
      if (saved === undefined) delete process.env.MCP_QA_API_BASE;
      else process.env.MCP_QA_API_BASE = saved;
    }
  });
});
