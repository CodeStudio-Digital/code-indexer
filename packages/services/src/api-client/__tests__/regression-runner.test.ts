/**
 * Tests for the non-LLM regression runner against a real local server:
 * status assertion, shape assertion, mutating-skip guard, and unverified-skip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { runCollection, type RunRequestLike } from '../regression-runner.js';

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/users' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 1, name: 'maicon' }));
    } else if (req.url === '/users' && req.method === 'DELETE') {
      res.writeHead(204); res.end();
    } else {
      res.writeHead(404); res.end('nf');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function mk(over: Partial<RunRequestLike>): RunRequestLike {
  return {
    id: 1, name: 'r', method: 'GET', path_template: '/users',
    headers_json: '{}', query_json: '{}', body_json: null, body_kind: 'none',
    expected_status: 200, assert_json: null, ...over,
  };
}

describe('runCollection', () => {
  it('passes a matching status + shape, fails a mismatch', async () => {
    const requests = [
      mk({ id: 1, expected_status: 200, assert_json: JSON.stringify({ shape: { id: 'number', name: 'string' } }) }),
      mk({ id: 2, expected_status: 201 }), // server returns 200 → fail
      mk({ id: 3, assert_json: JSON.stringify({ shape: { missing: 'string' } }) }), // shape fail
    ];
    const report = await runCollection({ requests, baseUrl: base, variables: {} });
    expect(report.results.find((r) => r.requestId === 1)?.ok).toBe(true);
    expect(report.results.find((r) => r.requestId === 2)?.ok).toBe(false);
    expect(report.results.find((r) => r.requestId === 3)?.reason).toMatch(/missing key/);
    expect(report.status).toBe('failed');
    expect(report.passed).toBe(1);
  });

  it('skips mutating methods unless includeMutating', async () => {
    const del = mk({ id: 9, method: 'DELETE', expected_status: 204 });
    const skipped = await runCollection({ requests: [del], baseUrl: base, variables: {} });
    expect(skipped.results[0].skipped).toBe(true);
    expect(skipped.skipped).toBe(1);

    const ran = await runCollection({ requests: [del], baseUrl: base, variables: {}, includeMutating: true });
    expect(ran.results[0].ok).toBe(true);
    expect(ran.passed).toBe(1);
  });

  it('skips unverified requests (no expected_status)', async () => {
    const r = await runCollection({ requests: [mk({ expected_status: null })], baseUrl: base, variables: {} });
    expect(r.results[0].skipped).toBe(true);
    expect(r.results[0].reason).toBe('not verified');
  });
});
