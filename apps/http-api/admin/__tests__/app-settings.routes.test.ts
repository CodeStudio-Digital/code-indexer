import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SANDBOX_LIMITS } from '@mcp/services/sandbox/types.js';
import { LEGACY_RUNTIME_POLICY_ENV_KEYS } from '@mcp/agent-runtime-host';

describe('app settings transaction and runtime application', () => {
  let folder: string;
  let dbPath: string;
  let db: Database.Database;
  beforeEach(() => {
    vi.resetModules();
    for (const key of LEGACY_RUNTIME_POLICY_ENV_KEYS) vi.stubEnv(key, undefined);
    folder = mkdtempSync(join(tmpdir(), 'settings-regression-'));
    dbPath = join(folder, 'test.sqlite');
    db = new Database(dbPath);
    db.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  });
  afterEach(() => {
    db.close();
    vi.unstubAllEnvs();
    rmSync(folder, { recursive: true, force: true });
  });
  const put = (app: Awaited<ReturnType<typeof router>>, updates: Record<string, unknown>) =>
    app.request('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ updates }) });
  async function router() {
    const { createAppSettingsRouter } = await import('../app-settings.routes.js');
    return createAppSettingsRouter(dbPath);
  }

  it('rejects an invalid batch before persisting or publishing any value', async () => {
    vi.stubEnv('MCP_WATCH_IDLE_MS', '4567');
    const app = await router();
    const response = await put(app, { MCP_WATCH_IDLE_MS: '9876', CODER_PARALLEL_AGENT_MAX: 'banana' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'invalid_setting', key: 'CODER_PARALLEL_AGENT_MAX' });
    expect(db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
    expect(process.env.MCP_WATCH_IDLE_MS).toBe('4567');
    expect((await app.request('/settings')).status).toBe(200);
  });

  it('rolls back the whole SQL batch and leaves environment untouched on a database failure', async () => {
    vi.stubEnv('MCP_WATCH_IDLE_MS', '4567');
    vi.stubEnv('MCP_AUTO_WATCH', '1');
    db.exec("CREATE TRIGGER reject_second BEFORE INSERT ON app_settings WHEN NEW.key = 'MCP_AUTO_WATCH' BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const { AppSettingsStore } = await import('@mcp/store/app-settings-store.js');
    const store = new AppSettingsStore(dbPath);
    try {
      expect(() => store.setMany({ MCP_WATCH_IDLE_MS: '9876', MCP_AUTO_WATCH: '0' })).toThrow('test failure');
      expect(db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
      expect(process.env.MCP_WATCH_IDLE_MS).toBe('4567');
      expect(process.env.MCP_AUTO_WATCH).toBe('1');
    } finally { store.close(); }
  });

  it('restores the inherited environment when clearing an override across store instances', async () => {
    vi.stubEnv('MCP_WATCH_DEBOUNCE_MS', '1777');
    const app = await router();
    expect((await put(app, { MCP_WATCH_DEBOUNCE_MS: '2222' })).status).toBe(200);
    expect(process.env.MCP_WATCH_DEBOUNCE_MS).toBe('2222');
    expect((await put(app, { MCP_WATCH_DEBOUNCE_MS: null })).status).toBe(200);
    expect(process.env.MCP_WATCH_DEBOUNCE_MS).toBe('1777');
    const body = await (await app.request('/settings')).json();
    expect(body.items.find((item: { key: string }) => item.key === 'MCP_WATCH_DEBOUNCE_MS')).toMatchObject({ value: '1777', source: 'env' });
  });

  it('ignores invalid legacy rows at startup while leaving them visible for correction', async () => {
    db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run('CODER_PARALLEL_AGENT_MAX', 'banana');
    const { AppSettingsStore } = await import('@mcp/store/app-settings-store.js');
    const store = new AppSettingsStore(dbPath);
    try { expect(store.applyToProcessEnv().applied).toBe(0); } finally { store.close(); }
    expect(process.env.CODER_PARALLEL_AGENT_MAX).toBeUndefined();
    const app = await router();
    const response = await app.request('/settings');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.items.find((item: { key: string }) => item.key === 'CODER_PARALLEL_AGENT_MAX')).toMatchObject({ value: 'banana', validationError: 'invalid_stored_value' });
    expect((await put(app, { CODER_PARALLEL_AGENT_MAX: 3 })).status).toBe(200);
  });

  it('keeps settings editable when an inherited runtime policy is invalid', async () => {
    vi.stubEnv('CODER_PARALLEL_AGENT_MAX', 'invalid');
    const app = await router();
    const body = await (await app.request('/settings')).json();
    expect(body.runtimePolicyError).toBe('invalid_runtime_policy');
    expect(body.items.length).toBeGreaterThan(0);
    expect((await put(app, { CODER_PARALLEL_AGENT_MAX: 2 })).status).toBe(200);
  });

  it('rejects incompatible inherited policy before committing a valid individual setting', async () => {
    vi.stubEnv('CODER_TOOL_CAP_DEFAULT', '20');
    vi.stubEnv('CODER_PREFLIGHT_VISIBLE_CAP', '21');
    const app = await router();
    expect((await put(app, { MCP_AUTO_WATCH: false })).status).toBe(400);
    expect(db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
  });

  it('uses sandbox settings imported before bootstrap for new operations', async () => {
    vi.stubEnv('MCP_SANDBOX_MEMORY', '1g');
    expect(DEFAULT_SANDBOX_LIMITS.memory).toBe('1g');
    const app = await router();
    expect((await put(app, { MCP_SANDBOX_MEMORY: '7g' })).status).toBe(200);
    expect(DEFAULT_SANDBOX_LIMITS.memory).toBe('7g');
    expect((await put(app, { MCP_SANDBOX_MEMORY: 'garbage', MCP_SANDBOX_CPUS: '-1' })).status).toBe(400);
    expect(DEFAULT_SANDBOX_LIMITS.memory).toBe('7g');
  });

  it('retains the restart requirement after a successful save and GET reload', async () => {
    vi.stubEnv('MCP_CODER_WORKER_DEBUG', '0');
    const app = await router();
    expect((await (await app.request('/settings')).json()).restartRequired).toBe(false);
    const result = await (await put(app, { MCP_CODER_WORKER_DEBUG: true })).json();
    expect(result.restartNeeded).toBe(true);
    expect((await (await app.request('/settings')).json()).restartRequired).toBe(true);
  });

  it.each([null, [], { updates: [] }, { updates: { MCP_AUTO_WATCH: {} } }, { updates: { MCP_AUTO_WATCH: 'banana' } }, { updates: { MCP_WATCH_IDLE_MS: -99 } }])('rejects malformed or invalid payload %j', async (body) => {
    const app = await router();
    const response = await app.request('/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    expect(db.prepare('SELECT * FROM app_settings').all()).toEqual([]);
  });
});
