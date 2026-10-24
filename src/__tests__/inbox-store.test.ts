/**
 * Filesystem-backed inbox integration tests. Operational Company inbox state
 * belongs to the session bundle; SQLite is intentionally absent here.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { formatInboxPrompt } from '@mcp/company/services/InboxQueue.js';
import {
  SessionLocator,
  asCompanySessionId,
  type AgentRunId,
  type JsonValue,
} from '@mcp/session-storage';

let dir: string;
let sessionStore: FsSessionStore;
let files: CompanySessionFiles;
let fromRunId: AgentRunId;
let toRunId: AgentRunId;

async function createRun(
  role: string,
  status: 'waiting' | 'running',
): Promise<AgentRunId> {
  return (
    await files.createAgentRun({
      role,
      coder_session_id: randomUUID(),
      project_ids: [1],
      provider: 'openai',
      model: 'gpt-5',
      status,
    })
  ).id;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-inbox-fs-'));
  const dataDir = join(dir, 'data');
  const projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });

  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) =>
        projectId === 1 ? projectRoot : null,
      listProjectRoots: () => [{
        project_id: 1,
        root_path: projectRoot,
      }],
    },
  });
  sessionStore = new FsSessionStore({ locator });
  const created = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 1 },
    owner_project_id: 1,
    linked_projects: [{ project_id: 1, root_path: projectRoot }],
    title: 'Inbox test',
    status: 'idle',
    metadata: {
      company: {
        name: 'Inbox test',
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
  fromRunId = await createRun('frontend', 'waiting');
  toRunId = await createRun('backend', 'waiting');
  await createRun('backend', 'running');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CompanySessionFiles — agent inbox', () => {
  it('createInboxMessage round-trips through getInboxMessage', () => {
    const msg = files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'where is auth?',
      waitToken: 'tok_1',
    });
    expect(msg.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(msg.status).toBe('pending');
    expect(msg.wait_token).toBe('tok_1');

    const fetched = files.getInboxMessageSync(msg.id);
    expect(fetched?.body).toBe('where is auth?');
    expect(fetched?.from_role).toBe('frontend');
    expect(fetched?.to_role).toBe('backend');
  });

  it('listInboxMessages filters by status and to_role', () => {
    files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'a',
    });
    files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'qa',
      kind: 'notify',
      body: 'b',
    });

    const toBackend = files.listInboxMessagesSync({
      toRole: 'backend',
      status: 'pending',
    });
    expect(toBackend).toHaveLength(1);
    expect(toBackend[0].body).toBe('a');

    const arrayStatus = files.listInboxMessagesSync({
      status: ['pending', 'delivered'],
    });
    expect(arrayStatus).toHaveLength(2);
  });

  it('claimNextInboxForAgent flips pending to delivered once', () => {
    const message = files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'first',
    });
    const claimed = files.claimNextInboxForAgentSync({
      agentRunId: toRunId,
      role: 'backend',
    });
    expect(claimed?.id).toBe(message.id);
    expect(claimed?.status).toBe('delivered');
    expect(claimed?.to_agent_run_id).toBe(toRunId);

    expect(
      files.claimNextInboxForAgentSync({
        agentRunId: toRunId,
        role: 'backend',
      }),
    ).toBeNull();
  });

  it('claimNextInboxForAgent ignores messages addressed to other roles', () => {
    files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'qa',
      kind: 'question',
      body: 'qa-only',
    });
    expect(
      files.claimNextInboxForAgentSync({
        agentRunId: toRunId,
        role: 'backend',
      }),
    ).toBeNull();
  });

  it('answerInboxMessage stores the answer and rejects a second answer', () => {
    const message = files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'q',
    });
    files.claimNextInboxForAgentSync({
      agentRunId: toRunId,
      role: 'backend',
    });
    const answered = files.answerInboxMessageSync(message.id, 'a');
    expect(answered?.status).toBe('answered');
    expect(answered?.answer).toBe('a');
    expect(answered?.answered_at).not.toBeNull();
    expect(files.answerInboxMessageSync(message.id, 'second')).toBeNull();
  });

  it('setInboxStatus moves a message to cancelled', () => {
    const message = files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'q',
    });
    const cancelled = files.setInboxStatusSync(message.id, 'cancelled', {
      answer: '(cancelled: deadlock)',
    });
    expect(cancelled?.status).toBe('cancelled');
    expect(cancelled?.answer).toContain('cancelled');
  });
});

describe('formatInboxPrompt', () => {
  it('renders the UUID, originator role and respond_to_inbox hint', () => {
    const message = files.createInboxMessageSync({
      fromAgentRunId: fromRunId,
      fromRole: 'frontend',
      toRole: 'backend',
      kind: 'question',
      body: 'name of auth fn?',
    });
    const claimed = files.claimNextInboxForAgentSync({
      agentRunId: toRunId,
      role: 'backend',
    });
    expect(claimed?.id).toBe(message.id);

    const output = formatInboxPrompt(claimed!);
    expect(output).toContain(`message_id=${message.id}`);
    expect(output).toContain('from=@frontend');
    expect(output).toContain('name of auth fn?');
    expect(output).toContain(`respond_to_inbox(message_id=${message.id}`);
  });
});
