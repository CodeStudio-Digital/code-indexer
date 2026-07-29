import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  parseIdParam,
  parseSeqParam,
  parseSeqQuery,
  parseSeqValue,
  parseSessionIdParam,
  parseSessionIdValue,
} from '../_helpers.js';

const SESSION_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ab';

function parserApp(): Hono {
  const app = new Hono();
  app.get('/session/:id', (c) => c.json({ id: parseSessionIdParam(c) }));
  app.get('/session/:id/message/:seq', (c) =>
    c.json({
      id: parseSessionIdParam(c),
      seq: parseSeqParam(c),
      before_seq: parseSeqQuery(c, 'before_seq'),
    }),
  );
  app.get('/project/:id', (c) => c.json({ id: parseIdParam(c) }));
  return app;
}

describe('session route parameter contract', () => {
  it('accepts canonical UUIDs as opaque strings and normalizes casing', async () => {
    const response = await parserApp().request(`/session/${SESSION_ID.toUpperCase()}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: SESSION_ID });
  });

  it.each([
    '1',
    '123abc',
    '018f0f5e7b2d7a458c110123456789ab',
    '018f0f5e-7b2d-7a45-8c11-0123456789ab-extra',
    '../018f0f5e-7b2d-7a45-8c11-0123456789ab',
  ])('rejects non-canonical session id %s without numeric fallback', async (id) => {
    const response = await parserApp().request(`/session/${encodeURIComponent(id)}`);
    expect(response.status).toBe(400);
  });

  it('keeps project ids numeric through the existing parser', async () => {
    const response = await parserApp().request('/project/42');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 42 });
  });

  it('validates UUIDs received in JSON batches without accepting numbers', () => {
    expect(parseSessionIdValue(SESSION_ID.toUpperCase())).toBe(SESSION_ID);
    expect(() => parseSessionIdValue(42)).toThrow('canonical session UUID');
  });

  it('parses message order and pagination as strict numeric sequences', async () => {
    const response = await parserApp().request(`/session/${SESSION_ID}/message/27?before_seq=26`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: SESSION_ID, seq: 27, before_seq: 26 });
  });

  it('parses positive JSON sequence values without coercing floats or zero', () => {
    expect(parseSeqValue(12)).toBe(12);
    expect(() => parseSeqValue(1.5)).toThrow('positive sequence');
    expect(() => parseSeqValue(0)).toThrow('positive sequence');
  });

  it.each([
    `/session/${SESSION_ID}/message/0`,
    `/session/${SESSION_ID}/message/-1`,
    `/session/${SESSION_ID}/message/1abc`,
    `/session/${SESSION_ID}/message/1?before_seq=-1`,
    `/session/${SESSION_ID}/message/1?before_seq=2abc`,
  ])('rejects malformed sequence input: %s', async (path) => {
    const response = await parserApp().request(path);
    expect(response.status).toBe(400);
  });
});
