/**
 * The database-client CRUD routes carry the same class of secret as the SSH
 * ones: hostnames, ports, usernames, the `enc_password`/`enc_ssl_*` blobs, and
 * a query history that quotes production SQL verbatim. They were mounted with
 * NO guard at all, while the standalone server can bind off-loopback and CORS
 * reflects any loopback origin — so any LAN peer, or any page open in the
 * user's browser, could enumerate the saved connections and PATCH one to point
 * at attacker infrastructure, harvesting the credential on the next Connect.
 *
 * `mountDbClientRoutes` now puts `requireTrustedLocalRequest` in front of all
 * three mounts. This pins BOTH halves, because either mistake is silent:
 *   - too loose → the leak comes back;
 *   - too strict → the packaged Electron app 403s its own Databases panel,
 *     since the renderer reaches these routes over `mcp://app` with no socket.
 *
 * Deliberately store-free (no better-sqlite3): the guard short-circuits before
 * any store call, and a fake store keeps this runnable under the Electron-built
 * native ABI where a real Database() throws ERR_DLOPEN_FAILED.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { IN_PROCESS_ENV } from '../../../middleware/local-origin.js';
import { mountDbClientRoutes } from '../index.js';
import type { ServerDeps } from '../../../deps.js';

const PID = 7;
const CONNECTIONS = `http://internal/api/projects/${PID}/db-client/connections`;
const SAVED = `http://internal/api/projects/${PID}/db-client/saved-queries`;
const HISTORY = `http://internal/api/projects/${PID}/db-client/connections/3/history`;

/** Socket metadata supplied by the Node HTTP adapter. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

/** Only the reads exercised below are stubbed; a refused request never gets here. */
const emptyStore = {
  listConnections: () => [],
  listSavedQueries: () => [],
  getConnection: () => null,
};

describe('db-client routes — trusted-local guard', () => {
  let app: HttpRouter;

  beforeEach(() => {
    app = new HttpRouter();
    mountDbClientRoutes(app, { dbClientFor: () => emptyStore } as unknown as ServerDeps);
  });

  // ─── Refused ───────────────────────────────────────────────────────

  it('refuses a request with no peer and no in-process marker', async () => {
    const res = await app.fetch(new Request(CONNECTIONS));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('localhost_only');
  });

  it('refuses an off-loopback peer', async () => {
    const res = await app.fetch(new Request(CONNECTIONS), peer('192.168.1.50'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('localhost_only');
  });

  it('refuses a remote browser origin even from a loopback peer', async () => {
    const req = new Request(CONNECTIONS, { headers: { origin: 'https://evil.test' } });
    const res = await app.fetch(req, peer('127.0.0.1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('local_origin_required');
  });

  it('refuses a sandboxed `null` origin (must not read as "no origin")', async () => {
    const req = new Request(CONNECTIONS, { headers: { origin: 'null' } });
    const res = await app.fetch(req, peer('127.0.0.1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('local_origin_required');
  });

  it('refuses a PATCH that would re-point a saved connection at another host', async () => {
    const req = new Request(`${CONNECTIONS}/3`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'attacker.test', port: 5432 }),
    });
    const res = await app.fetch(req, peer('192.168.1.50'));
    expect(res.status).toBe(403);
  });

  it('guards history and saved queries too (all three mounts share one guard)', async () => {
    for (const url of [HISTORY, SAVED]) {
      const res = await app.fetch(new Request(url), peer('192.168.1.50'));
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('localhost_only');
    }
  });

  // ─── Allowed ───────────────────────────────────────────────────────

  it('admits the in-process Electron dispatch, which has no socket', async () => {
    const res = await app.fetch(new Request(CONNECTIONS), IN_PROCESS_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connections: [] });
  });

  it('admits a loopback peer with no Origin (curl, dev tooling)', async () => {
    const res = await app.fetch(new Request(CONNECTIONS), peer('127.0.0.1'));
    expect(res.status).toBe(200);
  });

  it('admits a loopback peer with a localhost Origin (browser dev)', async () => {
    const req = new Request(CONNECTIONS, { headers: { origin: 'http://localhost:5173' } });
    const res = await app.fetch(req, peer('::ffff:127.0.0.1'));
    expect(res.status).toBe(200);
  });

  it('admits the saved-queries sub-route in-process', async () => {
    const res = await app.fetch(new Request(SAVED), IN_PROCESS_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ savedQueries: [] });
  });
});
