import { describe, expect, it } from 'vitest';
import type { PluginToolContext } from '@mcp/plugin-sdk';
import { allTools } from '../all-tools.js';

type Route = (
  url: URL,
  init: RequestInit | undefined,
) => Response | Promise<Response>;

function json(result: unknown, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ success: true, result, ...extra }), {
    headers: { 'content-type': 'application/json' },
  });
}

function tool(name: string) {
  const t = allTools.find((candidate) => candidate.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
}

function makeCtx(route: Route): PluginToolContext {
  const storage = new Map<string, string>([
    ['apiToken', 'token-123'],
    ['accountId', 'acct-123'],
  ]);
  return {
    projectName: 'test',
    cwd: 'D:/tmp/project',
    log: () => undefined,
    fetch: async (input, init) => route(new URL(String(input)), init),
    host: { invoke: async () => null },
    storage: {
      get: async (key) => storage.get(key) ?? null,
      set: async (key, value) => {
        storage.set(key, value);
      },
      delete: async (key) => {
        storage.delete(key);
      },
      list: async () => [...storage.keys()],
    },
  };
}

describe('cloudflare plugin tools', () => {
  it('paginates Cloudflare list endpoints', async () => {
    const seen: string[] = [];
    const ctx = makeCtx((url) => {
      seen.push(url.search);
      const page = Number(url.searchParams.get('page'));
      return json(
        page === 1 ? [{ id: 'a', title: 'A' }] : [{ id: 'b', title: 'B' }],
        { result_info: { page, total_pages: 2 } },
      );
    });

    const result = await tool('cf_kv_list').handler({}, ctx);

    expect(result.data).toEqual({ rows: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }] });
    expect(seen).toEqual(['?page=1&per_page=100', '?page=2&per_page=100']);
  });

  it('uses parameterized SQL for D1 row inserts', async () => {
    let queryBody: Record<string, unknown> | null = null;
    const ctx = makeCtx(async (url, init) => {
      if (url.pathname.endsWith('/d1/database')) {
        return json([{ uuid: 'db-1', name: 'main' }], { result_info: { page: 1, total_pages: 1 } });
      }
      if (url.pathname.endsWith('/d1/database/db-1/query')) {
        queryBody = JSON.parse(String(init?.body));
        return json([{ results: [], meta: { changed_db: true } }]);
      }
      throw new Error(url.pathname);
    });

    await tool('cf_d1_row_insert').handler(
      { database: 'main', table: 'users', data: { name: 'Ada', age: 37 } },
      ctx,
    );

    expect(queryBody).toEqual({
      sql: 'INSERT INTO "users" ("name", "age") VALUES (?, ?)',
      params: ['Ada', 37],
    });
  });

  it('models protected queue pull and ack payloads', async () => {
    let ackBody: Record<string, unknown> | null = null;
    const ctx = makeCtx(async (url, init) => {
      if (url.pathname.endsWith('/queues/q1/messages/pull')) {
        expect(JSON.parse(String(init?.body))).toEqual({
          batch_size: 2,
          visibility_timeout_ms: 5000,
        });
        return json({ messages: [{ lease_id: 'lease-1', body: 'hello' }] });
      }
      if (url.pathname.endsWith('/queues/q1/messages/ack')) {
        ackBody = JSON.parse(String(init?.body));
        return json({});
      }
      throw new Error(url.pathname);
    });

    const pulled = await tool('cf_queue_pull').handler(
      { queueId: 'q1', batch_size: 2, visibility_timeout_ms: 5000 },
      ctx,
    );
    await tool('cf_queue_ack').handler({ queueId: 'q1', leaseIds: ['lease-1'] }, ctx);

    expect((pulled.data as { rows: unknown[] }).rows).toEqual([{ lease_id: 'lease-1', body: 'hello' }]);
    expect(ackBody).toEqual({ acks: [{ lease_id: 'lease-1' }] });
  });

  it('uses raw text reads for KV values', async () => {
    const ctx = makeCtx((url) => {
      expect(url.pathname).toBe('/client/v4/accounts/acct-123/storage/kv/namespaces/ns1/values/k1');
      return new Response('raw-value');
    });

    const result = await tool('cf_kv_get').handler({ namespaceId: 'ns1', key: 'k1' }, ctx);

    expect(result.content).toBe('raw-value');
    expect(result.data).toEqual({ details: { key: 'k1', value: 'raw-value' } });
  });

  it('lists Durable Object objects without storage mutation tools', async () => {
    const ctx = makeCtx((url) => {
      expect(url.pathname).toBe('/client/v4/accounts/acct-123/workers/durable_objects/namespaces/ns1/objects');
      return json([{ id: 'object-a' }], { result_info: { page: 1, total_pages: 1 } });
    });

    const result = await tool('cf_do_objects').handler({ namespaceId: 'ns1' }, ctx);

    expect(result.data).toEqual({ rows: [{ id: 'object-a' }] });
    expect(allTools.some((t) => t.name === 'cf_do_storage_update')).toBe(false);
  });

  it('sends representative DNS and R2 mutations to the right endpoints', async () => {
    const calls: Array<{ path: string; method: string | undefined }> = [];
    const ctx = makeCtx((url, init) => {
      calls.push({ path: url.pathname, method: init?.method });
      return json({});
    });

    await tool('cf_dns_delete').handler({ zoneId: 'zone1', recordId: 'rec1' }, ctx);
    await tool('cf_r2_object_delete').handler({ bucket: 'bucket-a', key: 'file.txt' }, ctx);

    expect(calls).toEqual([
      { path: '/client/v4/zones/zone1/dns_records/rec1', method: 'DELETE' },
      { path: '/client/v4/accounts/acct-123/r2/buckets/bucket-a/objects/file.txt', method: 'DELETE' },
    ]);
  });
});
