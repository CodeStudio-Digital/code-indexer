/**
 * Unit tests for the `api_*` agent tools using an in-memory fake store (no
 * sqlite) — validates list/get/update/mark_verified logic and api_run_request
 * against a real local server (status + last_status persistence).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ApiClientStore } from '@mcp/store/api-client-store.js';
import { apiClientTools, setApiClientStore } from '../index.js';

const tool = (name: string) => apiClientTools.find((t) => t.name === name)!;
const ctx = (over: Partial<ToolContext> = {}) => ({ projectId: 1, cwd: process.cwd(), ...over }) as ToolContext;

interface Req {
  id: number; collection_id: number; name: string; method: string; path_template: string;
  headers_json: string; query_json: string; body_json: string | null; body_kind: string;
  verified: boolean; expected_status: number | null; assert_json: string | null; last_status: number | null;
}

function fakeStore(reqs: Req[]): ApiClientStore {
  const map = new Map(reqs.map((r) => [r.id, r]));
  return {
    listRequests: (cid: number) => [...map.values()].filter((r) => r.collection_id === cid),
    getRequest: (id: number) => map.get(id) ?? null,
    updateRequest: (id: number, patch: Record<string, unknown>) => Object.assign(map.get(id)!, patch),
    markVerified: (id: number, st: number, assert: string | null) =>
      Object.assign(map.get(id)!, { verified: true, expected_status: st, assert_json: assert }),
    getCollection: (id: number) => ({ id }),
    getDefaultEnvironment: () => ({ id: 1, base_url: BASE, variables_json: '{}' }),
    getEnvironment: () => ({ id: 1, base_url: BASE, variables_json: '{}' }),
    createRun: () => 7,
    finishRun: () => undefined,
  } as unknown as ApiClientStore;
}

let server: Server;
let BASE = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/users') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":1}'); }
    else if (req.url === '/large') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(`${'x'.repeat(80_000)}UNREAD_TAIL`); }
    else { res.writeHead(404); res.end('nf'); }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  BASE = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => { setApiClientStore(null); return new Promise<void>((r) => server.close(() => r())); });

const REQ: Req = {
  id: 1, collection_id: 5, name: 'list users', method: 'GET', path_template: '/users',
  headers_json: '{}', query_json: '{}', body_json: null, body_kind: 'none',
  verified: false, expected_status: null, assert_json: null, last_status: null,
};

describe('api_* tools', () => {
  beforeEach(() => setApiClientStore(fakeStore([{ ...REQ }])));

  it('errors clearly when the store is not wired', async () => {
    setApiClientStore(null);
    const r = await tool('api_list_requests').handler({ collectionId: 5 }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not wired/i);
  });

  it('errors when no project is bound', async () => {
    const r = await tool('api_list_requests').handler({ collectionId: 5 }, ctx({ projectId: undefined }));
    expect(r.isError).toBe(true);
  });

  it('lists requests with verification state', async () => {
    const r = await tool('api_list_requests').handler({ collectionId: 5 }, ctx());
    expect(r.content).toContain('GET /users');
    expect(r.content).toContain('✗ unverified');
  });

  it('updates a request (the fix action)', async () => {
    const r = await tool('api_update_request').handler({ requestId: 1, headers: { Authorization: 'Bearer x' } }, ctx());
    expect(r.isError).toBeFalsy();
    const got = await tool('api_get_request').handler({ requestId: 1 }, ctx());
    expect(got.content).toContain('Authorization');
  });

  it('marks a request verified', async () => {
    const r = await tool('api_mark_verified').handler({ requestId: 1, expectedStatus: 200 }, ctx());
    expect(r.content).toMatch(/verified/);
    const got = await tool('api_get_request').handler({ requestId: 1 }, ctx());
    expect(got.content).toContain('"expected_status": 200');
  });

  it('runs a request against the live server and reports the status', async () => {
    const r = await tool('api_run_request').handler({ requestId: 1 }, ctx());
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('200');
    expect(r.content).toContain('"id":1');
  });

  it('marks an acquisition-capped response in both text and structured metadata', async () => {
    const previous = process.env.MCP_API_CLIENT_READ_CAP;
    process.env.MCP_API_CLIENT_READ_CAP = '65536';
    try {
      setApiClientStore(fakeStore([{ ...REQ, id: 2, path_template: '/large' }]));
      const r = await tool('api_run_request').handler({ requestId: 2 }, ctx());

      expect(r.content).toContain('[source truncated: network read ceiling reached');
      expect(r.content).not.toContain('UNREAD_TAIL');
      expect(r.sourceTruncations).toEqual([
        expect.objectContaining({
          technique: 'network-acquisition-cap',
          inputSizeExact: false,
          outputSize: 65_536,
          unit: 'bytes',
          recoverable: false,
        }),
      ]);
    } finally {
      if (previous === undefined) delete process.env.MCP_API_CLIENT_READ_CAP;
      else process.env.MCP_API_CLIENT_READ_CAP = previous;
    }
  });
});
