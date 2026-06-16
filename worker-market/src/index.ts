/**
 * Hosted plugin Market — Cloudflare Worker.
 *
 *   GET  /health
 *   GET  /plugins?q=<query>            search catalog (public)
 *   GET  /plugins/:name                one plugin's info (public)
 *   GET  /bundle/:name/:version        stream the zip + `X-Signature` header (public)
 *   POST /publish?name=&version=       store + sign a bundle (Bearer AUTH_TOKEN)
 *
 * Signing: `/publish` signs sha256(zip) with Ed25519; the host re-hashes the
 * downloaded bytes and verifies the signature before extracting.
 */
import {
  searchPlugins, getPlugin, getVersionRow, recordDownload, upsertVersion,
  listPendingPlugins, approvePlugin,
} from './catalog.js';
import { signBundle } from './sign.js';

interface Env {
  DB: D1Database;
  BUNDLES: R2Bucket;
  AUTH_TOKEN: string;
  MARKET_SIGNING_PRIVKEY: string;
  MARKET_SIGNING_PUBKEY: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function authorize(request: Request, env: Env): Response | null {
  const auth = request.headers.get('Authorization');
  if (!auth || auth !== `Bearer ${env.AUTH_TOKEN}`) return json({ error: 'Unauthorized' }, 401);
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (path === '/health' && method === 'GET') return json({ ok: true });

    if (path === '/plugins' && method === 'GET') {
      return json(await searchPlugins(env.DB, url.searchParams.get('q') ?? ''));
    }

    const infoMatch = path.match(/^\/plugins\/([^/]+)$/);
    if (infoMatch && method === 'GET') {
      const info = await getPlugin(env.DB, decodeURIComponent(infoMatch[1]));
      return info ? json(info) : json({ error: 'not found' }, 404);
    }

    const bundleMatch = path.match(/^\/bundle\/([^/]+)\/([^/]+)$/);
    if (bundleMatch && method === 'GET') {
      const name = decodeURIComponent(bundleMatch[1]);
      const version = decodeURIComponent(bundleMatch[2]);
      const row = await getVersionRow(env.DB, name, version);
      if (!row) return json({ error: 'not found' }, 404);
      const obj = await env.BUNDLES.get(row.r2_key);
      if (!obj) return json({ error: 'bundle missing' }, 404);
      await recordDownload(env.DB, name, version);
      return new Response(obj.body, {
        headers: { 'Content-Type': 'application/zip', 'X-Signature': row.signature },
      });
    }

    if (path === '/publish' && method === 'POST') {
      const authErr = authorize(request, env);
      if (authErr) return authErr;
      const name = url.searchParams.get('name');
      const version = url.searchParams.get('version');
      if (!name || !version) return json({ error: 'name and version query params required' }, 400);
      // Constrain to a safe charset — `name`/`version` flow into the R2 key
      // `${name}/${version}.zip`; reject path-traversal / namespace pollution.
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(name) || !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(version)) {
        return json({ error: 'invalid name or version format' }, 400);
      }
      const bundle = await request.arrayBuffer();
      const { sha256, signature } = await signBundle(env.MARKET_SIGNING_PRIVKEY, bundle);
      const r2Key = `${name}/${version}.zip`;
      await env.BUNDLES.put(r2Key, bundle);
      await upsertVersion(env.DB, { name, version, r2Key, size: bundle.byteLength, sha256, signature });
      // A brand-new plugin lands approved=0 (pending moderation); re-publishing
      // an already-approved one keeps its approval (upsert leaves the column).
      return json({ ok: true, name, version, sha256, pending: !(await getPlugin(env.DB, name)) });
    }

    // ── Moderation (Bearer AUTH_TOKEN) ──────────────────────────────────
    if (path === '/admin/plugins/pending' && method === 'GET') {
      const authErr = authorize(request, env);
      if (authErr) return authErr;
      return json(await listPendingPlugins(env.DB));
    }

    const approveMatch = path.match(/^\/plugins\/([^/]+)\/approve$/);
    if (approveMatch && method === 'POST') {
      const authErr = authorize(request, env);
      if (authErr) return authErr;
      const ok = await approvePlugin(env.DB, decodeURIComponent(approveMatch[1]));
      return ok ? json({ ok: true }) : json({ error: 'not found' }, 404);
    }

    return json({ error: 'not found' }, 404);
  },
};
