/**
 * The SSH CRUD routes carry the whole credential surface: hostnames, usernames,
 * ports and the `enc_*` blobs, plus every named `${secret:…}` value. They used
 * to be mounted with NO guard at all, while global CORS is `*` and the
 * standalone server binds off-loopback by default — so any LAN peer, or any web
 * page open in the user's browser, could enumerate the fleet and PATCH a saved
 * host to point at attacker infrastructure.
 *
 * `mountSshRoutes` now puts `requireTrustedLocalRequest` in front of all four
 * mounts. This test pins BOTH halves of that guard, because getting either one
 * wrong is silent:
 *   - too loose → the leak comes back;
 *   - too strict → the packaged Electron app 403s its own SSH panel, since the
 *     renderer reaches these routes over `mcp://app` with no socket at all.
 *
 * Deliberately store-free (no better-sqlite3): the guard short-circuits before
 * any store call, and a fake store keeps this runnable under the Electron-built
 * native ABI where a real Database() throws ERR_DLOPEN_FAILED.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { IN_PROCESS_ENV } from '../../../middleware/local-origin.js';
import { mountSshRoutes } from '../index.js';
import type { ServerDeps } from '../../../deps.js';

const PID = 7;
const HOSTS = `http://internal/api/projects/${PID}/ssh/hosts`;
const SECRETS = `http://internal/api/projects/${PID}/ssh/secrets`;

/** Socket metadata supplied by the Node HTTP adapter. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

/** Only the reads exercised below are stubbed; a refused request never gets here. */
const emptyStore = {
  listSharedHosts: () => [],
  listHosts: () => [],
  listSecrets: () => [],
  getHost: () => undefined,
};

describe('ssh routes — trusted-local guard', () => {
  let app: HttpRouter;

  beforeEach(() => {
    app = new HttpRouter();
    mountSshRoutes(app, { sshStore: emptyStore, sshStoreFor: () => emptyStore } as unknown as ServerDeps);
  });

  // ─── Refused ───────────────────────────────────────────────────────

  it('refuses a request with no peer and no in-process marker', async () => {
    const res = await app.fetch(new Request(HOSTS));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('localhost_only');
  });

  it('refuses an off-loopback peer', async () => {
    const res = await app.fetch(new Request(HOSTS), peer('192.168.1.50'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('localhost_only');
  });

  it('refuses a remote browser origin even from a loopback peer', async () => {
    const req = new Request(HOSTS, { headers: { origin: 'https://evil.test' } });
    const res = await app.fetch(req, peer('127.0.0.1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('local_origin_required');
  });

  it('refuses a sandboxed `null` origin (must not read as "no origin")', async () => {
    const req = new Request(HOSTS, { headers: { origin: 'null' } });
    const res = await app.fetch(req, peer('127.0.0.1'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('local_origin_required');
  });

  it('refuses writes, not just reads', async () => {
    const req = new Request(HOSTS, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'pwned', hostname: 'attacker.test', username: 'root' }),
    });
    const res = await app.fetch(req, peer('192.168.1.50'));
    expect(res.status).toBe(403);
  });

  it('guards the secrets sub-route too (all four mounts share one guard)', async () => {
    const res = await app.fetch(new Request(SECRETS), peer('192.168.1.50'));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('localhost_only');
  });

  // ─── Allowed ───────────────────────────────────────────────────────

  it('admits the in-process Electron dispatch, which has no socket', async () => {
    const res = await app.fetch(new Request(HOSTS), IN_PROCESS_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hosts: [] });
  });

  it('admits a loopback peer with no Origin (curl, dev tooling)', async () => {
    const res = await app.fetch(new Request(HOSTS), peer('127.0.0.1'));
    expect(res.status).toBe(200);
  });

  it('admits a loopback peer with a localhost Origin (browser dev)', async () => {
    const req = new Request(HOSTS, { headers: { origin: 'http://localhost:5173' } });
    const res = await app.fetch(req, peer('::ffff:127.0.0.1'));
    expect(res.status).toBe(200);
  });

  it('admits the secrets sub-route in-process', async () => {
    const res = await app.fetch(new Request(SECRETS), IN_PROCESS_ENV);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ secrets: [] });
  });
});
