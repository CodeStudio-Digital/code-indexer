import { describe, expect, it } from 'vitest';
import type { AppStudioSession } from '@mcp/store/app-studio-store.js';
import type {
  CreateDbConnectionInput,
  DbConnection,
  DbConnectionPatch,
} from '@mcp/store/db-client-store-types.js';
import {
  ensureAppStudioDbConnection,
  type AppStudioDbClientStore,
} from '../db-client-bridge.js';

function session(overrides: Partial<AppStudioSession> = {}): AppStudioSession {
  return {
    id: 7,
    project_id: 42,
    name: 'FutebolFantasy',
    app_slug: 'futebol-fantasy',
    stack: 'cf-fullstack',
    db_engine: 'd1',
    spec_json: null,
    pipeline_json: null,
    deploy_json: null,
    blueprint_json: null,
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function row(input: CreateDbConnectionInput, id: number): DbConnection {
  return {
    id,
    project_id: input.project_id,
    label: input.label,
    engine: input.engine,
    host: input.host ?? null,
    port: input.port ?? null,
    username: input.username ?? null,
    database_name: input.database_name ?? null,
    file_path: input.file_path ?? null,
    enc_password: input.enc_password ?? null,
    ssl_mode: input.ssl_mode ?? null,
    enc_ssl_ca: input.enc_ssl_ca ?? null,
    enc_ssl_cert: input.enc_ssl_cert ?? null,
    enc_ssl_key: input.enc_ssl_key ?? null,
    ssh_tunnel_host_id: input.ssh_tunnel_host_id ?? null,
    ssh_tunnel_json: input.ssh_tunnel_json ?? null,
    options_json: JSON.stringify(input.options ?? {}),
    color: input.color ?? null,
    group_name: input.group_name ?? null,
    sort_order: 0,
    is_read_only: input.is_read_only ? 1 : 0,
    last_used_at: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

function fakeStore(initial: DbConnection[] = []): AppStudioDbClientStore & { rows: DbConnection[] } {
  let nextId = initial.reduce((max, conn) => Math.max(max, conn.id), 0) + 1;
  const rows = [...initial];
  return {
    rows,
    listConnections: (projectId) => rows.filter((conn) => conn.project_id === projectId),
    createConnection: (input) => {
      const created = row(input, nextId++);
      rows.push(created);
      return created;
    },
    updateConnection: (_projectId: number, id: number, patch: DbConnectionPatch) => {
      const idx = rows.findIndex((conn) => conn.id === id);
      if (idx < 0) return;
      const current = rows[idx];
      rows[idx] = {
        ...current,
        ...patch,
        options_json: patch.options ? JSON.stringify(patch.options) : current.options_json,
        is_read_only: patch.is_read_only === undefined ? current.is_read_only : patch.is_read_only ? 1 : 0,
        updated_at: '2026-01-02T00:00:00.000Z',
      } as DbConnection;
    },
  };
}

describe('ensureAppStudioDbConnection', () => {
  it('creates a native sqlite connection for the App Studio local database', () => {
    const store = fakeStore();
    const result = ensureAppStudioDbConnection(store, session(), 'C:/app/.wrangler/state/v3/d1/local.sqlite');

    expect(result.created).toBe(true);
    expect(result.connection).toMatchObject({
      project_id: 42,
      label: 'App Studio: FutebolFantasy',
      engine: 'sqlite',
      database_name: 'futebol-fantasy-db',
      file_path: 'C:/app/.wrangler/state/v3/d1/local.sqlite',
      group_name: 'App Studio',
      is_read_only: 0,
    });
    expect(JSON.parse(result.connection.options_json)).toMatchObject({
      managedBy: 'app-studio',
      appSessionId: 7,
      appSlug: 'futebol-fantasy',
      bindingName: 'DB',
    });
  });

  it('updates the managed connection instead of duplicating it', () => {
    const s = session();
    const store = fakeStore();
    ensureAppStudioDbConnection(store, s, 'C:/old.sqlite');

    const second = ensureAppStudioDbConnection(store, { ...s, name: 'Futebol Fantasy Pro' }, 'C:/new.sqlite');

    expect(second.created).toBe(false);
    expect(store.rows).toHaveLength(1);
    expect(store.rows[0]).toMatchObject({
      label: 'App Studio: Futebol Fantasy Pro',
      file_path: 'C:/new.sqlite',
    });
  });
});
