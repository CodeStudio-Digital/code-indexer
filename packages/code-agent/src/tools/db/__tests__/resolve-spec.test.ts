import { describe, expect, it } from 'vitest';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import { resolveConnConfig, scrubDbError, usesSshTunnel } from '../resolve-spec.js';

/** Fake decryptor: `blob:<x>` → `<x>` (async, like the worker bridge RPC). */
const decrypt = async (blob: string): Promise<string> => {
  if (!blob.startsWith('blob:')) throw new Error('unknown blob');
  return blob.slice(5);
};

const row = (over: Partial<DbConnection> = {}): DbConnection => ({
  id: 3,
  project_id: 10,
  label: 'main',
  engine: 'postgres',
  host: 'db.example.com',
  port: 5432,
  username: 'app',
  database_name: 'appdb',
  file_path: null,
  enc_password: 'blob:s3cr3t',
  ssl_mode: null,
  enc_ssl_ca: null,
  enc_ssl_cert: null,
  enc_ssl_key: null,
  ssh_tunnel_host_id: null,
  ssh_tunnel_json: null,
  options_json: '{}',
  color: null,
  group_name: null,
  sort_order: 0,
  is_read_only: 0,
  last_used_at: null,
  created_at: 'now',
  updated_at: 'now',
  ...over,
});

describe('resolveConnConfig', () => {
  it('field mode: decrypts the password and maps username → user', async () => {
    const spec = await resolveConnConfig(row(), decrypt);
    expect(spec.config).toMatchObject({
      engine: 'postgres',
      host: 'db.example.com',
      port: 5432,
      user: 'app',
      password: 's3cr3t',
      database: 'appdb',
    });
    expect(spec.config.connectionString).toBeUndefined();
    expect(spec.secrets).toContain('s3cr3t');
  });

  it('urlMode: the decrypted blob IS the connection string', async () => {
    const dsn = 'postgres://app:pw123@h:5432/db';
    const spec = await resolveConnConfig(
      row({ enc_password: `blob:${dsn}`, options_json: '{"urlMode":true}' }),
      decrypt,
    );
    expect(spec.config.connectionString).toBe(dsn);
    expect(spec.config.host).toBeUndefined();
    expect(spec.secrets).toContain(dsn);
  });

  it('ports options (timeout/appName) and decrypts ssl material', async () => {
    const spec = await resolveConnConfig(
      row({
        ssl_mode: 'verify-full',
        enc_ssl_ca: 'blob:CA',
        enc_ssl_key: 'blob:KEYMATERIAL',
        options_json: '{"connectTimeoutMs":1500,"applicationName":"agent","junk":1}',
      }),
      decrypt,
    );
    expect(spec.config.ssl).toEqual({ mode: 'verify-full', ca: 'CA', cert: undefined, key: 'KEYMATERIAL' });
    expect(spec.config.options).toEqual({ connectTimeoutMs: 1500, applicationName: 'agent' });
    expect(spec.secrets).toContain('KEYMATERIAL');
  });

  it('refuses SSH-tunneled connections (saved host or inline spec)', async () => {
    await expect(resolveConnConfig(row({ ssh_tunnel_host_id: 9 }), decrypt)).rejects.toThrow(/SSH tunnel/);
    await expect(
      resolveConnConfig(row({ ssh_tunnel_json: '{"host":"bastion"}' }), decrypt),
    ).rejects.toThrow(/SSH tunnel/);
    expect(usesSshTunnel(row({ ssh_tunnel_json: 'null' }))).toBe(false);
    expect(usesSshTunnel(row())).toBe(false);
  });

  it('no enc_password → never calls the decryptor', async () => {
    const boom = () => {
      throw new Error('decryptor must not run');
    };
    const spec = await resolveConnConfig(row({ enc_password: null, engine: 'sqlite', file_path: 'x.db' }), boom);
    expect(spec.config.password).toBeUndefined();
    expect(spec.secrets).toEqual([]);
  });
});

describe('scrubDbError', () => {
  it('masks the decrypted password and any DSN credentials', async () => {
    const spec = await resolveConnConfig(row(), decrypt);
    const e = new Error('auth failed for "app" with password "s3cr3t" at postgres://app:s3cr3t@h:5432/db');
    const msg = scrubDbError(e, spec);
    expect(msg).not.toContain('s3cr3t');
    expect(msg).toContain('***');
    expect(msg).toContain('postgres://app:***@h:5432/db');
  });

  it('masks URL credentials even without a spec (existing-pool errors)', () => {
    expect(scrubDbError(new Error('mysql://root:hunter2@h/db refused'), null)).toBe(
      'mysql://root:***@h/db refused',
    );
    expect(scrubDbError('plain string', undefined)).toBe('plain string');
  });
});
