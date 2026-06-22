import { describe, it, expect } from 'vitest';
import { redactExample } from '../redact-example.js';

const cap = (over: Partial<Parameters<typeof redactExample>[0]> = {}) => ({
  name: 'ex',
  req: { method: 'GET', url: 'https://api.x.com/v1/me?token=supersecretvalue123&page=1', headers: { Authorization: 'Bearer abc', 'X-Trace': '1' }, body: null },
  resp: { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json', 'set-cookie': 'sid=abc' }, body: '{"jwt":"eyJabc123.eyJpayload99.sigSIGsig00","name":"x"}' },
  ...over,
});

describe('redactExample', () => {
  it('drops sensitive headers (req + resp) and counts them', () => {
    const r = redactExample(cap(), []);
    const req = JSON.parse(r.req_snapshot_json) as { headers: Record<string, string> };
    const resp = JSON.parse(r.resp_headers_json) as Record<string, string>;
    expect(req.headers.Authorization).toBe('«redacted»');
    expect(req.headers['X-Trace']).toBe('1');
    expect(resp['set-cookie']).toBe('«redacted»');
    expect(r.redaction_count).toBeGreaterThan(0);
  });

  it('strips the URL query string (in-query secrets never persist)', () => {
    const req = JSON.parse(redactExample(cap(), []).req_snapshot_json) as { url: string };
    expect(req.url).toBe('https://api.x.com/v1/me');
    expect(req.url).not.toContain('supersecretvalue');
  });

  it('masks JWTs in the response body', () => {
    const r = redactExample(cap(), []);
    expect(r.resp_body).not.toContain('eyJabc123');
    expect(r.resp_body).toContain('«redacted»');
  });

  it('masks exact env-secret values anywhere in the body', () => {
    const r = redactExample(cap({ resp: { status: 200, statusText: 'OK', headers: {}, body: '{"key":"MY-TOP-SECRET-9"}' } }), ['MY-TOP-SECRET-9']);
    expect(r.resp_body).not.toContain('MY-TOP-SECRET-9');
    expect(r.redaction_count).toBeGreaterThan(0);
  });
});
