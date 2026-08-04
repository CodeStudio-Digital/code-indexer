import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { asSessionId } from '@mcp/session-storage';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../../deps.js';
import type { PersistedRuntimeEventRecord } from '../../../../../sse/runtime-event-log-storage.js';
import {
  __flushRuntimeEventLogsForTests,
  __resetRuntimeEventLogsForTests,
  installRuntimeEventLog,
} from '../../../../../sse/runtime-event-log.js';
import { createBus, publish } from '../../../../../coder-bus.js';
import { SessionWorkbenchEventService } from '../event-service.js';
import { mountSessionWorkbenchRoutes } from '../routes.js';

const SESSION_ID = asSessionId('00000000-0000-4000-8000-000000000081');

function event(
  revision: number,
  name: string,
  data: Record<string, unknown>,
  busId?: string,
): PersistedRuntimeEventRecord {
  return {
    id: `00000000-0000-4000-8000-${revision.toString().padStart(12, '0')}`,
    revision,
    event: {
      seq: revision - 1,
      event: name,
      data,
      ts: Date.parse('2026-08-01T12:00:00.000Z') + revision,
      kind: 'coder',
      sessionId: SESSION_ID,
      ...(busId ? { busId } : {}),
    },
  };
}

function fixture() {
  const records = [
    event(5, 'worker_log', {
      category: 'route',
      level: 'warn',
      message: 'authorization: Bearer secret-token-value',
    }, 'bus-new'),
    event(4, 'tool_call_start', { name: 'read_file', opId: 'op-4' }, 'bus-new'),
    event(3, 'operation_progress', { phase: 'streaming', elapsedMs: 42 }),
    event(2, 'error', { message: 'failed', retryable: true }),
    event(1, 'provider_call', { status: 'started' }),
  ];
  const listPage = vi.fn(async (_sessionId: string, input: { cursor?: string; limit: number }) => {
    const offset = input.cursor ? Number(input.cursor) : 0;
    const items = records.slice(offset, offset + input.limit);
    const next = offset + items.length;
    return {
      items,
      nextCursor: next < records.length ? String(next) : null,
      totalCount: input.cursor ? null : records.length,
    };
  });
  return { records, listPage, service: new SessionWorkbenchEventService({ listPage }) };
}

describe('SessionWorkbenchEventService', () => {
  it('normalizes, redacts and keeps durable bus/seq/revision identity', async () => {
    const { service } = fixture();
    const page = await service.list(SESSION_ID, { limit: 2 });

    expect(page.events).toHaveLength(2);
    expect(page.revision).toBe(5);
    expect(page.events[0]).toMatchObject({
      busId: 'bus-new',
      seq: 4,
      revision: 5,
      type: 'execution.event',
      resource: 'execution',
      data: {
        category: 'route',
        severity: 'warning',
        message: 'authorization: Bearer [redacted]',
      },
    });
    expect(page.nextCursor).toBeTypeOf('string');
  });

  it('filters server-side without skipping records and gives legacy rows deterministic identities', async () => {
    const { service, listPage } = fixture();
    const first = await service.list(SESSION_ID, { category: 'tool', limit: 1 });
    expect(first.events).toEqual([
      expect.objectContaining({
        busId: 'bus-new',
        revision: 4,
        data: expect.objectContaining({ category: 'tool', operationId: 'op-4' }),
      }),
    ]);
    expect(listPage).toHaveBeenCalledTimes(2);

    const later = await service.list(SESSION_ID, { level: 'error', limit: 10 });
    expect(later.events).toHaveLength(1);
    expect(later.events[0]).toMatchObject({
      busId: `legacy:${fixture().records[3]!.id}`,
      data: { severity: 'error', retryable: true },
    });
  });

  it('rejects a cursor from another session', async () => {
    const { service } = fixture();
    const first = await service.list(SESSION_ID, { limit: 1 });
    const other = asSessionId('00000000-0000-4000-8000-000000000082');
    await expect(service.list(other, { limit: 1, cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: 'invalid_cursor', status: 400 });
  });
});

describe('Session Workbench event route', () => {
  it('validates filters and exposes a conditional GET for the canonical page', async () => {
    const { service } = fixture();
    const app = new Hono();
    mountSessionWorkbenchRoutes(app, {} as ServerDeps, {
      service: { listSessions: vi.fn(), bootstrap: vi.fn() } as never,
      resources: {
        context: vi.fn(), execution: vi.fn(), insights: vi.fn(), configuration: vi.fn(),
      } as never,
      events: service,
    });

    const invalid = await app.request(
      `/api/coder/session-workbench/sessions/${SESSION_ID}/events?level=debug`,
    );
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 'invalid_query' });

    const response = await app.request(
      `/api/coder/session-workbench/sessions/${SESSION_ID}/events?category=tool&limit=1`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      contractVersion: 1,
      sessionId: SESSION_ID,
      replayGap: false,
      events: [expect.objectContaining({ type: 'execution.event' })],
    });
    const etag = response.headers.get('etag');
    expect(etag).toBe(`"csw-${SESSION_ID}-events-5"`);

    const notModified = await app.request(
      `/api/coder/session-workbench/sessions/${SESSION_ID}/events?category=tool&limit=1`,
      { headers: { 'If-None-Match': etag! } },
    );
    expect(notModified.status).toBe(304);
  });

  it('backfills the same canonical schema from filesystem after process-local state is cleared', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'csw-event-restart-'));
    const bundlePath = path.join(root, SESSION_ID);
    mkdirSync(bundlePath, { recursive: true });
    const bus = createBus(new AbortController());
    const detach = installRuntimeEventLog(bus, 'coder', SESSION_ID, { bundlePath });
    try {
      publish(bus, 'operation_progress', { opId: 'restart-op', phase: 'persisted' });
      await __flushRuntimeEventLogsForTests();
      detach();
      __resetRuntimeEventLogsForTests();

      const app = new Hono();
      mountSessionWorkbenchRoutes(app, {
        sessionStore: {
          getSessionLocation: vi.fn(async () => ({ bundle_path: bundlePath })),
        },
      } as unknown as ServerDeps, {
        service: { listSessions: vi.fn(), bootstrap: vi.fn() } as never,
        resources: {
          context: vi.fn(), execution: vi.fn(), insights: vi.fn(), configuration: vi.fn(),
        } as never,
      });

      const response = await app.request(
        `/api/coder/session-workbench/sessions/${SESSION_ID}/events`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        totalCount: 1,
        events: [{
          busId: bus.busId,
          seq: 0,
          type: 'execution.event',
          data: { operationId: 'restart-op', category: 'runner' },
        }],
      });
    } finally {
      detach();
      await __flushRuntimeEventLogsForTests();
      __resetRuntimeEventLogsForTests();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
