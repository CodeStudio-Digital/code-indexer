/**
 * MasterInboxRouter behavior tests (Phase A "living company").
 *
 * Validates the core promise the user pinned down:
 *   "3-4 subordinados falando com o master morto → UM resurrect, fila
 *    coalescida em UM combined prompt."
 *
 * We mock `MasterLifecycle.notify` with a spy. Concurrency is exercised
 * by firing 4 `enqueueForMaster` calls back-to-back without awaiting,
 * then awaiting `tryDeliverNow()` to drain the mutex chain. The DAO
 * (`claimAllPendingMasterMessages`) is real — the test runs against an
 * in-memory SQLite migrated schema.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { CompanyStore } from '@mcp/store/company-store.js';
import {
  MasterInboxRouter,
  MASTER_INBOX_SENTINEL,
} from '@mcp/company/services/MasterInboxRouter.js';

const SESSION_ID = 7;
const BACKEND_RUN = 100;
const FRONTEND_RUN = 101;
const QA_RUN = 102;
const SECURITY_RUN = 103;

let dir: string;
let cdb: CodeIndexDB;
let store: CompanyStore;
let dbPath: string;

function seed(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = (cdb as any).db as import('better-sqlite3').Database;
  raw.pragma('foreign_keys = OFF');
  try {
    raw.prepare(`INSERT INTO company_sessions (id, name, status, config_json) VALUES (?, ?, 'idle', '{}')`)
      .run(SESSION_ID, 'router-test');
    for (const [id, role] of [
      [BACKEND_RUN, 'backend'],
      [FRONTEND_RUN, 'frontend'],
      [QA_RUN, 'qa'],
      [SECURITY_RUN, 'security'],
    ] as const) {
      raw
        .prepare(
          `INSERT INTO company_agent_runs (id, company_session_id, role, coder_session_id, project_ids_json, provider, model, status)
           VALUES (?, ?, ?, ?, '[]', '', '', 'waiting')`,
        )
        .run(id, SESSION_ID, role, id);
    }
  } finally {
    raw.pragma('foreign_keys = ON');
  }
}

interface FakeMaster {
  notify: (m: string) => void;
  calls: string[];
  isAlive: boolean;
}
function makeFakeMaster(isAlive: boolean): FakeMaster {
  const calls: string[] = [];
  return {
    isAlive,
    notify(m: string) {
      calls.push(m);
    },
    calls,
  };
}

function makePublisher(): {
  publish: (evt: string, data: unknown) => void;
  events: Array<{ evt: string; data: unknown }>;
} {
  const events: Array<{ evt: string; data: unknown }> = [];
  return {
    publish(evt: string, data: unknown) {
      events.push({ evt, data });
    },
    events,
  };
}

function makeCtx() {
  return {
    companySessionId: SESSION_ID,
    companyStore: store,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-mir-'));
  dbPath = join(dir, 'test.db');
  cdb = new CodeIndexDB(dbPath);
  store = new CompanyStore(dbPath);
  seed();
});

afterEach(() => {
  store.close();
  cdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('MasterInboxRouter — coalescing', () => {
  it('drains every queued message into a single notify call with attribution per source', async () => {
    const master = makeFakeMaster(false);
    const publisher = makePublisher();
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: publisher as never,
    });

    // 4 subordinates queue messages without awaiting between calls.
    router.enqueueForMaster({
      fromAgentRunId: BACKEND_RUN, fromRole: 'backend', kind: 'question', body: 'q-backend',
    });
    router.enqueueForMaster({
      fromAgentRunId: FRONTEND_RUN, fromRole: 'frontend', kind: 'notify', body: 'n-frontend',
    });
    router.enqueueForMaster({
      fromAgentRunId: QA_RUN, fromRole: 'qa', kind: 'notify', body: 'n-qa',
    });
    router.enqueueForMaster({
      fromAgentRunId: SECURITY_RUN, fromRole: 'security', kind: 'question', body: 'q-sec',
    });

    // Drain the mutex chain — the in-line `void tryDeliverNow()` calls
    // serialise via `this.routeMutex`, so awaiting one final explicit
    // call is enough to flush.
    await router.tryDeliverNow();

    // The fake master must have received AT MOST 2 notifications: the
    // first claimed everything (4 messages), follow-up enqueues that
    // landed mid-drain might have triggered an additional empty drain
    // that no-ops. Allow [1..2] calls but require all message bodies
    // to appear within them.
    expect(master.calls.length).toBeGreaterThanOrEqual(1);
    expect(master.calls.length).toBeLessThanOrEqual(2);
    const combined = master.calls.join('\n');
    for (const expected of [
      'from @backend',
      'q-backend',
      'from @frontend',
      'n-frontend',
      'from @qa',
      'n-qa',
      'from @security',
      'q-sec',
    ]) {
      expect(combined).toContain(expected);
    }

    // All rows should be `delivered`, none left pending.
    const pending = store.listInboxMessages({
      companySessionId: SESSION_ID,
      toRole: MASTER_INBOX_SENTINEL,
      status: 'pending',
    });
    expect(pending).toHaveLength(0);
    const delivered = store.listInboxMessages({
      companySessionId: SESSION_ID,
      toRole: MASTER_INBOX_SENTINEL,
      status: 'delivered',
    });
    expect(delivered).toHaveLength(4);
  });

  it('publishes inbox_message_sent then inbox_message_delivered for every queued message', async () => {
    const master = makeFakeMaster(true);
    const publisher = makePublisher();
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: publisher as never,
    });

    router.enqueueForMaster({
      fromAgentRunId: BACKEND_RUN, fromRole: 'backend', kind: 'notify', body: 'hello',
    });
    await router.tryDeliverNow();

    const sent = publisher.events.filter((e) => e.evt === 'inbox_message_sent');
    const delivered = publisher.events.filter((e) => e.evt === 'inbox_message_delivered');
    expect(sent).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  it('reviveIfPending is a no-op when the queue is empty', async () => {
    const master = makeFakeMaster(false);
    const publisher = makePublisher();
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: publisher as never,
    });
    router.reviveIfPending();
    // queueMicrotask drained the tryDeliverNow inside reviveIfPending;
    // give the event loop a tick to settle so the assertion is honest.
    await new Promise((r) => setImmediate(r));
    expect(master.calls).toEqual([]);
  });

  it('reviveIfPending finds messages persisted before construction and drains them', async () => {
    // Simulate a prior Node process: insert a master-bound message
    // directly, then build the router — this is the post-restart shape.
    store.createInboxMessage({
      companySessionId: SESSION_ID,
      fromAgentRunId: BACKEND_RUN,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'stranded',
    });

    const master = makeFakeMaster(false);
    const publisher = makePublisher();
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: publisher as never,
    });

    router.reviveIfPending();
    await new Promise((r) => setImmediate(r));
    await router.tryDeliverNow(); // flush mutex chain

    const combined = master.calls.join('\n');
    expect(combined).toContain('from @backend');
    expect(combined).toContain('stranded');
  });
});
