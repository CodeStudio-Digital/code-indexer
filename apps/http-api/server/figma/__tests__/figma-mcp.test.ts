import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodeIndexDB } from '@mcp/store/db.js';
import { InstalledPluginStore } from '@mcp/store/installed-plugin-store.js';
import { PluginStorageStore } from '@mcp/store/plugin-storage-store.js';
import { McpExternalPool } from '../../../sse/McpExternalPool.js';
import { setMainSecretDecryptor, setMainSecretEncryptor } from '../../secret-decrypt-port.js';
import { BundledFigmaMcp, FIGMA_SERVER_ID } from '../integration.js';

const signal = new AbortController().signal;
const key = 'SmokeTestDesign';
const link = `https://www.figma.com/design/${key}/Demo?node-id=10-20`;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64');
const asset = 'https://s3-alpha-sig.figma.com/img/smoke.png';

async function setup() {
  const temp = resolve(tmpdir());
  const dir = mkdtempSync(join(temp, 'figma-mcp-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new CodeIndexDB(dbPath);
  const plugins = new InstalledPluginStore(db.raw());
  plugins.upsert({ namespace: 'figma', name: 'figma', version: '1.0.0', source: 'bundled' });
  const storage = new PluginStorageStore(db.raw());
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.href === asset) {
      expect(new Headers(init?.headers).has('X-Figma-Token')).toBe(false);
      return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
    }
    expect(url.origin).toBe('https://api.figma.com');
    const token = new Headers(init?.headers).get('X-Figma-Token');
    if (token === 'expired-fixture') return Response.json({}, { status: 403 });
    expect(token).toBe('figma-fixture-account-token');
    expect(init?.redirect).toBe('error');
    if (url.pathname === '/v1/me') return Response.json({ id: 'fixture-account', handle: 'Demo Designer' });
    if (url.pathname === `/v1/files/${key}`) {
      return Response.json({ name: 'Fixture file', document: { children: [{ id: '1:2', name: 'Page 1', type: 'CANVAS' }] } });
    }
    if (url.pathname === `/v1/files/${key}/nodes`) {
      expect(url.searchParams.get('ids')).toBe('10:20');
      return Response.json({ version: 'fixture-v1', nodes: { '10:20': {
        document: { id: '10:20', name: 'Hero', type: 'FRAME', layoutMode: 'HORIZONTAL', itemSpacing: 16,
          children: [{ id: '10:21', name: 'Title', type: 'TEXT', characters: 'Bem-vindo', style: { fontSize: 24 } }] },
      } } });
    }
    if (url.pathname === `/v1/images/${key}`) return Response.json({ images: { '10:20': asset } });
    if (url.pathname === `/v1/files/${key}/variables/local`) return Response.json({}, { status: 429, headers: { 'Retry-After': '45' } });
    return Response.json({}, { status: 404 });
  });
  setMainSecretEncryptor(() => 'enc:ciphertext-fixture');
  setMainSecretDecryptor(blob => blob === 'enc:ciphertext-fixture' ? 'figma-fixture-account-token' : '');
  const figma = new BundledFigmaMcp(db.raw(), fetcher);
  const pool = new McpExternalPool({ dbPath, embedded: figma });
  figma.refresh = () => pool.refreshServer(FIGMA_SERVER_ID);
  cleanup = async () => {
    await pool.shutdown();
    db.close();
    if (dirname(dir) === temp && basename(dir).startsWith('figma-mcp-test-')) rmSync(dir, { recursive: true, force: true });
  };
  await pool.boot();
  return { figma, pool, fetcher, plugins, storage };
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  setMainSecretEncryptor(null);
  setMainSecretDecryptor(null);
});

describe('bundled Figma MCP', () => {
  it('publishes six tools through the shared MCP pool after a single connection', async () => {
    const { figma, pool, storage, fetcher } = await setup();
    expect(pool.getSnapshot().tools).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const status = await figma.manage({ action: 'connect', token: ' figma-fixture-account-token ' }, signal);
    expect(status).toEqual({ connected: true, account: 'Demo Designer', toolCount: 6 });
    expect(storage.get('figma', 'mcp.connection')).toContain('enc:ciphertext-fixture');
    expect(storage.get('figma', 'mcp.connection')).not.toContain('figma-fixture-account-token');
    const snapshot = await pool.getReadySnapshot();
    expect(snapshot.tools).toHaveLength(6);
    expect(JSON.stringify(snapshot)).not.toContain('figma-fixture-account-token');
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_metadata', { file: key })).toMatchObject({
      ok: true, result: { structuredData: { name: 'Fixture file', pages: [{ id: '1:2', name: 'Page 1' }] } },
    });
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_design_context', { file: link })).toMatchObject({
      ok: true, result: { structuredData: { layer: '10:20', nodes: [
        { id: '10:20', layoutMode: 'HORIZONTAL', itemSpacing: 16 },
        { id: '10:21', parentId: '10:20', characters: 'Bem-vindo', style: { fontSize: 24 } },
      ] } },
    });
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_screenshot', { file: link })).toMatchObject({
      ok: true, result: { extraUserBlocks: [{ type: 'image', mediaType: 'image/png', base64: png.toString('base64') }] },
    });
    expect(await pool.callTool(FIGMA_SERVER_ID, 'export_assets', { file: link, format: 'svg' })).toMatchObject({
      ok: true, result: { structuredData: { format: 'svg', assets: [{ nodeId: '10:20', url: asset }] } },
    });
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_variables', { file: key })).toMatchObject({
      ok: false, text: 'Figma rate limit reached. Retry after 45 seconds.',
    });
  });

  it('preserves a previous connection on failed replacement and retires tools on disconnect', async () => {
    const { figma, pool, storage, fetcher } = await setup();
    await figma.manage({ action: 'connect', token: 'figma-fixture-account-token' }, signal);
    const previous = storage.get('figma', 'mcp.connection');
    await expect(figma.manage({ action: 'connect', token: 'expired-fixture' }, signal)).rejects.toThrow(/current_user:read/);
    expect(storage.get('figma', 'mcp.connection')).toBe(previous);
    const revision = pool.getSnapshot().tools.find(tool => tool.toolName === 'get_metadata')?.catalogueRevision;
    const requests = fetcher.mock.calls.length;
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_metadata', { file: 'https://example.test/design/Example' })).toMatchObject({ ok: false });
    await figma.manage({ action: 'disconnect' }, signal);
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_metadata', { file: key }, signal, revision)).toMatchObject({ ok: false });
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect(pool.getSnapshot().tools).toEqual([]);
    expect(storage.get('figma', 'mcp.connection')).toBeNull();
  });

  it('withholds the token and catalogue when the plugin is disabled', async () => {
    const { figma, pool, plugins, fetcher } = await setup();
    await figma.manage({ action: 'connect', token: 'figma-fixture-account-token' }, signal);
    plugins.setEnabled('figma', false);
    const requests = fetcher.mock.calls.length;
    expect(await pool.callTool(FIGMA_SERVER_ID, 'get_metadata', { file: key })).toMatchObject({ ok: false });
    expect(fetcher.mock.calls).toHaveLength(requests);
    expect((await pool.getReadySnapshot()).tools).toEqual([]);
  });
});
