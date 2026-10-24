/**
 * MasterInboxRouter behavior against the filesystem Company bundle.
 *
 * Several subordinates can enqueue while the master is dormant; delivery is
 * coalesced through one per-session mutex and every persisted item is claimed
 * exactly once from independent JSON entities.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import {
  MASTER_INBOX_SENTINEL,
  MasterInboxRouter,
} from '@mcp/company/services/MasterInboxRouter.js';
import {
  SessionLocator,
  asCompanySessionId,
  type AgentRunId,
  type JsonValue,
} from '@mcp/session-storage';

let dir: string;
let files: CompanySessionFiles;
let backendRun: AgentRunId;
let frontendRun: AgentRunId;
let qaRun: AgentRunId;
let securityRun: AgentRunId;

interface FakeMaster {
  notify: (message: string) => void;
  calls: string[];
  isAlive: boolean;
}

function makeFakeMaster(isAlive: boolean): FakeMaster {
  const calls: string[] = [];
  return {
    isAlive,
    notify(message: string) {
      calls.push(message);
    },
    calls,
  };
}

function makePublisher(): {
  publish: (event: string, data: unknown) => void;
  events: Array<{ event: string; data: unknown }>;
} {
  const events: Array<{ event: string; data: unknown }> = [];
  return {
    publish(event: string, data: unknown) {
      events.push({ event, data });
    },
    events,
  };
}

function makeCtx() {
  return {
    companySessionId: files.companySessionId,
    companyFiles: files,
  };
}

async function createRun(role: string): Promise<AgentRunId> {
  return (
    await files.createAgentRun({
      role,
      coder_session_id: randomUUID(),
      project_ids: [1],
      provider: 'openai',
      model: 'gpt-5',
      status: 'waiting',
    })
  ).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-master-inbox-router-fs-'));
  const dataDir = join(dir, 'data');
  const projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  const sessionStore = new FsSessionStore({
    locator: new SessionLocator({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 1 ? projectRoot : null,
        listProjectRoots: () => [{
          project_id: 1,
          root_path: projectRoot,
        }],
      },
    }),
  });
  const created = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 1 },
    owner_project_id: 1,
    linked_projects: [{ project_id: 1, root_path: projectRoot }],
    title: 'Router test',
    status: 'idle',
    metadata: {
      company: {
        name: 'Router test',
        template_id: null,
        runtime_kind: 'company',
        config_json: '{}',
        master_session_id: null,
        project_labels: { 1: 'main' },
        recovered_at: null,
        recovered_reason: null,
      },
    } as unknown as Record<string, JsonValue>,
  });
  await sessionStore.refresh();
  files = new CompanySessionFiles({
    companySessionId: asCompanySessionId(created.session.id),
    sessionStore,
  });
  backendRun = await createRun('backend');
  frontendRun = await createRun('frontend');
  qaRun = await createRun('qa');
  securityRun = await createRun('security');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('MasterInboxRouter — coalescing', () => {
  it('drains queued messages with attribution for every source', async () => {
    const master = makeFakeMaster(false);
    const publisher = makePublisher();
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: publisher as never,
    });

    router.enqueueForMaster({
      fromAgentRunId: backendRun,
      fromRole: 'backend',
      kind: 'question',
      body: 'q-backend',
    });
    router.enqueueForMaster({
      fromAgentRunId: frontendRun,
      fromRole: 'frontend',
      kind: 'notify',
      body: 'n-frontend',
    });
    router.enqueueForMaster({
      fromAgentRunId: qaRun,
      fromRole: 'qa',
      kind: 'notify',
      body: 'n-qa',
    });
    router.enqueueForMaster({
      fromAgentRunId: securityRun,
      fromRole: 'security',
      kind: 'question',
      body: 'q-sec',
    });
    await router.tryDeliverNow();

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
    expect(
      files.listInboxMessagesSync({
        toRole: MASTER_INBOX_SENTINEL,
        status: 'pending',
      }),
    ).toHaveLength(0);
    expect(
      files.listInboxMessagesSync({
        toRole: MASTER_INBOX_SENTINEL,
        status: 'delivered',
      }),
    ).toHaveLength(4);
  });

  it('publishes sent then delivered for each queued message', async () => {
    const master = makeFakeMaster(true);
    const publisher = makePublisher();
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: publisher as never,
    });

    router.enqueueForMaster({
      fromAgentRunId: backendRun,
      fromRole: 'backend',
      kind: 'notify',
      body: 'hello',
    });
    await router.tryDeliverNow();

    expect(
      publisher.events.filter(({ event }) => event === 'inbox_message_sent'),
    ).toHaveLength(1);
    expect(
      publisher.events.filter(
        ({ event }) => event === 'inbox_message_delivered',
      ),
    ).toHaveLength(1);
  });

  it('reviveIfPending is a no-op when the queue is empty', async () => {
    const master = makeFakeMaster(false);
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: makePublisher() as never,
    });
    router.reviveIfPending();
    await new Promise((resolve) => setImmediate(resolve));
    expect(master.calls).toEqual([]);
  });

  it('reviveIfPending drains messages persisted before construction', async () => {
    files.createInboxMessageSync({
      fromAgentRunId: backendRun,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'stranded',
    });
    const master = makeFakeMaster(false);
    const router = new MasterInboxRouter({
      ctx: makeCtx() as never,
      master: master as never,
      publisher: makePublisher() as never,
    });

    router.reviveIfPending();
    await new Promise((resolve) => setImmediate(resolve));
    await router.tryDeliverNow();

    const combined = master.calls.join('\n');
    expect(combined).toContain('from @backend');
    expect(combined).toContain('stranded');
  });
});
