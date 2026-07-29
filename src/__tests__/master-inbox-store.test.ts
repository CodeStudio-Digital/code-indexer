/**
 * Master-inbox persistence tests against the session filesystem bundle.
 * No operational Company table or SQLite transaction participates.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import {
  MASTER_INBOX_SENTINEL,
  formatMasterInboxPrompt,
} from '@mcp/company/services/MasterInboxRouter.js';
import {
  SessionLocator,
  asCompanySessionId,
  type AgentRunId,
  type JsonValue,
} from '@mcp/session-storage';

let dir: string;
let projectRoot: string;
let sessionStore: FsSessionStore;
let filesA: CompanySessionFiles;
let filesB: CompanySessionFiles;
let backendRunA: AgentRunId;
let frontendRunA: AgentRunId;
let qaRunA: AgentRunId;
let backendRunB: AgentRunId;

async function createCompanyFiles(name: string): Promise<CompanySessionFiles> {
  const created = await sessionStore.repository.createSession({
    kind: 'company',
    scope: { kind: 'project', project_id: 1 },
    owner_project_id: 1,
    linked_projects: [{ project_id: 1, root_path: projectRoot }],
    title: name,
    status: 'idle',
    metadata: {
      company: {
        name,
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
  return new CompanySessionFiles({
    companySessionId: asCompanySessionId(created.session.id),
    sessionStore,
  });
}

async function createRun(
  files: CompanySessionFiles,
  role: string,
): Promise<AgentRunId> {
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
  dir = mkdtempSync(join(tmpdir(), 'mcp-master-inbox-fs-'));
  const dataDir = join(dir, 'data');
  projectRoot = join(dir, 'project');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(projectRoot, { recursive: true });
  sessionStore = new FsSessionStore({
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

  filesA = await createCompanyFiles('a');
  filesB = await createCompanyFiles('b');
  backendRunA = await createRun(filesA, 'backend');
  frontendRunA = await createRun(filesA, 'frontend');
  qaRunA = await createRun(filesA, 'qa');
  backendRunB = await createRun(filesB, 'backend');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CompanySessionFiles — master inbox sentinel', () => {
  it('accepts the __master__ sentinel as a free-form to_role', () => {
    const message = filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'deploy ok',
    });
    expect(message.to_role).toBe(MASTER_INBOX_SENTINEL);
    expect(message.status).toBe('pending');
  });

  it('claims every pending master message in sequence order exactly once', () => {
    const first = filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'question',
      body: 'q1',
    });
    const second = filesA.createInboxMessageSync({
      fromAgentRunId: frontendRunA,
      fromRole: 'frontend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'question',
      body: 'q2',
    });
    const third = filesA.createInboxMessageSync({
      fromAgentRunId: qaRunA,
      fromRole: 'qa',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'q3',
    });

    const claimed = filesA.claimAllPendingMasterMessagesSync();
    expect(claimed.map((message) => message.id)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(claimed.every((message) => message.status === 'delivered')).toBe(
      true,
    );
    expect(filesA.claimAllPendingMasterMessagesSync()).toEqual([]);
  });

  it('does not claim sibling-session or peer-targeted messages', () => {
    filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: 'frontend',
      kind: 'question',
      body: 'peer-only',
    });
    filesB.createInboxMessageSync({
      fromAgentRunId: backendRunB,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'wrong-session',
    });
    expect(filesA.claimAllPendingMasterMessagesSync()).toEqual([]);
  });

  it('catalog scan returns every bundle with pending master work', () => {
    filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'a',
    });
    filesB.createInboxMessageSync({
      fromAgentRunId: backendRunB,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'b',
    });

    expect(
      filesA.listSessionsWithPendingMasterInboxAcrossCatalog().sort(),
    ).toEqual([filesA.companySessionId, filesB.companySessionId].sort());
  });

  it('catalog scan excludes already-delivered rows', () => {
    filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'will-be-drained',
    });
    filesA.claimAllPendingMasterMessagesSync();
    expect(
      filesA.listSessionsWithPendingMasterInboxAcrossCatalog(),
    ).toEqual([]);
  });
});

describe('formatMasterInboxPrompt', () => {
  it('combines UUID-addressed messages with per-source attribution', () => {
    const question = filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'question',
      body: 'how to handle auth headers?',
    });
    const notice = filesA.createInboxMessageSync({
      fromAgentRunId: frontendRunA,
      fromRole: 'frontend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'notify',
      body: 'smoke tests green',
    });
    const output = formatMasterInboxPrompt([question, notice]);

    expect(output).toContain('[INBOX — 2 message(s) from subordinates]');
    expect(output).toContain(
      `[from @backend, run=${backendRunA}, message_id=${question.id}, kind=question]`,
    );
    expect(output).toContain('how to handle auth headers?');
    expect(output).toContain(
      `[from @frontend, run=${frontendRunA}, message_id=${notice.id}, kind=notify]`,
    );
    expect(output).toContain('smoke tests green');
    expect(output).toContain('respond_to_inbox(message_id, answer)');
  });

  it('uses the question-only footer and handles an empty list', () => {
    const question = filesA.createInboxMessageSync({
      fromAgentRunId: backendRunA,
      fromRole: 'backend',
      toRole: MASTER_INBOX_SENTINEL,
      kind: 'question',
      body: 'x?',
    });
    const output = formatMasterInboxPrompt([question]);
    expect(output).toContain('Respond via respond_to_inbox');
    expect(output).not.toContain('FYI notification');
    expect(formatMasterInboxPrompt([])).toBe('');
  });
});
