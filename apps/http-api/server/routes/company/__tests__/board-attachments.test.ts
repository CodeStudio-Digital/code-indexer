import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { companyFixture } from '@mcp/company/services/__tests__/company-multisession-fixture.js';
import { persistBoardAttachments } from '@mcp/company/services/board-attachments.js';
import { BoardBridge } from '@mcp/company/services/BoardBridge.js';
import type { SessionContext } from '@mcp/company/services/SessionContext.js';
import type { ServerDeps } from '../../../deps.js';
import { mountCompanyBoardRoutes } from '../board.js';

async function fixture() {
  const fixture = await companyFixture();
  const files = fixture.files(fixture.child.id);
  const image = await sharp({ create: { width: 12, height: 8, channels: 4, background: '#7869ef' } }).png().toBuffer();
  const attachments = await persistBoardAttachments(files, [
    { name: 'captura.png', mediaType: 'image/png', base64: image.toString('base64') },
    { name: 'contrato.json', mediaType: 'application/json', text: '{"valid":true}' },
  ]);
  const events: unknown[] = [];
  const board = new BoardBridge({ companyFiles: files } as unknown as SessionContext,
    { publish: (_type: string, data: unknown) => { events.push(data); } } as never, {} as never);
  board.post('human', null, 'message', 'Confira os anexos', undefined, attachments);
  const entry = fixture.files(fixture.child.id).listBoardEntriesSync()[0]!;
  const app = new Hono(); mountCompanyBoardRoutes(app, { sessionStore: fixture.sessionStore } as unknown as ServerDeps);
  const base = `/api/company/sessions/${fixture.child.id}/board/${entry.id}/attachments`;
  return { ...fixture, app, base, entry, image, events };
}

describe('Company board original attachments', () => {
  it('persists only references in board/SSE and serves the exact original after reload', async () => {
    const f = await fixture();
    expect(f.entry.attachments).toHaveLength(2);
    expect(f.events).toEqual([expect.objectContaining({ attachments: f.entry.attachments })]);
    expect(JSON.stringify(f.entry)).not.toContain(f.image.toString('base64'));
    const response = await f.app.request(`${f.base}/0`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('captura.png');
    expect(Buffer.from(await response.arrayBuffer()).equals(f.image)).toBe(true);
    const text = await f.app.request(`${f.base}/1?text=1`);
    expect(await text.json()).toEqual({ text: '{"valid":true}', truncated: false });
  });
  it('returns a real thumbnail and does not serve documents as active inline content', async () => {
    const f = await fixture();
    const thumbnail = await f.app.request(`${f.base}/0?thumbnail=1`);
    expect(thumbnail.status).toBe(200);
    expect((await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata()).width).toBeLessThanOrEqual(240);
    expect((await f.app.request(`${f.base}/1?preview=1`)).status).toBe(415);
    expect((await f.app.request(`${f.base}/0?text=1`)).status).toBe(415);
  });
  it('does not cross sessions or accept invalid indices and corrupted blobs', async () => {
    const f = await fixture();
    expect((await f.app.request(f.base.replace(f.child.id, f.foreign.id) + '/0')).status).toBe(404);
    expect((await f.app.request(`${f.base}/-1`)).status).toBe(400);
    expect((await f.app.request(`${f.base}/99`)).status).toBe(404);
    const hash = f.entry.attachments![0]!.sha256;
    await writeFile(join(f.files(f.child.id).location.bundle_path, 'attachments/blobs/sha256', hash.slice(0, 2), hash), 'corrupt');
    expect((await f.app.request(`${f.base}/0`)).status).toBe(422);
  });
  it('keeps pre-existing text-only board history readable', async () => {
    const f = await fixture();
    const old = f.files(f.child.id).createBoardEntry({ authorRole: 'human', agentRunId: null, kind: 'message', content: 'Legacy message' });
    expect(f.files(f.child.id).getBoardEntrySync(old.id)?.content).toBe('Legacy message');
    expect((await f.app.request(`/api/company/sessions/${f.child.id}/board/${old.id}/attachments/0`)).status).toBe(404);
  });
});
