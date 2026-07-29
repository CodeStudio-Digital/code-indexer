import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';
import {
  SessionLocator,
  asCompanySessionId,
  type JsonValue,
} from '@mcp/session-storage';
import { CompanySessionFiles } from '../CompanySessionFiles.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe('CompanySessionFiles', () => {
  it('persists UUID agent runs independently inside the Company bundle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'company-session-files-'));
    cleanup.push(root);
    const dataDir = join(root, 'data');
    const projectRoot = join(root, 'project');
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(projectRoot, { recursive: true }),
    ]);
    const locator = new SessionLocator({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 7 ? projectRoot : null,
        listProjectRoots: () => [{
          project_id: 7,
          root_path: projectRoot,
        }],
      },
    });
    const store = new FsSessionStore({ locator });
    const company = await store.repository.createSession({
      kind: 'company',
      scope: { kind: 'project', project_id: 7 },
      owner_project_id: 7,
      linked_projects: [{ project_id: 7, root_path: projectRoot }],
      title: 'Company',
      status: 'idle',
      metadata: {
        company: {
          name: 'Company',
          template_id: 3,
          runtime_kind: 'company',
          config_json: '{}',
          master_session_id: null,
          project_labels: { 7: 'main' },
          recovered_at: null,
          recovered_reason: null,
        },
      } as unknown as Record<string, JsonValue>,
    });
    await store.refresh();
    const coder = await store.createSession({
      project_id: 7,
      parent_session_id: company.session.id,
      title: 'Master',
      provider: 'openai',
      model: 'gpt-5',
      metadata: {
        company_session_id: company.session.id,
        companySessionId: company.session.id,
      },
    });
    const files = new CompanySessionFiles({
      companySessionId: asCompanySessionId(company.session.id),
      sessionStore: store,
    });

    const run = await files.createAgentRun({
      role: 'master',
      coder_session_id: coder.id,
      project_ids: [7],
      provider: 'openai',
      model: 'gpt-5',
    });
    await files.setMasterSessionId(coder.id);
    await files.updateAgentRunStatus(run.id, 'running', 'booted');
    await files.updateSessionConfig(JSON.stringify({
      role_assignments: [{ role: 'frontend', provider: 'openai' }],
    }));

    expect(run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect((await files.getAgentRun(run.id))?.status_message).toBe('booted');
    expect(files.getAgentRunSync(run.id)?.status_message).toBe('booted');
    expect(files.listAgentRunsSync().map((candidate) => candidate.id)).toEqual([
      run.id,
    ]);
    expect(files.getSession().master_session_id).toBe(coder.id);
    expect(JSON.parse(files.getSession().config_json)).toMatchObject({
      role_assignments: [{ role: 'frontend' }],
    });

    const subordinate = await files.createAgentRun({
      role: 'frontend',
      coder_session_id: coder.id,
      project_ids: [7],
      provider: 'openai',
      model: 'gpt-5',
      status: 'running',
    });
    expect(files.countActiveSubordinatesAcrossCatalog()).toBe(1);
    await files.updateAgentRunStatus(subordinate.id, 'completed');
    expect(files.countActiveSubordinatesAcrossCatalog()).toBe(0);

    const masterPost = files.createBoardEntry({
      authorRole: 'master',
      agentRunId: run.id,
      kind: 'decision',
      content: 'Use the filesystem journal.',
      mentions: ['frontend'],
    });
    const humanPost = files.createBoardEntry({
      authorRole: 'human',
      agentRunId: null,
      kind: 'message',
      content: 'Proceed.',
    });
    const subordinatePost = files.createBoardEntry({
      authorRole: 'frontend',
      agentRunId: subordinate.id,
      kind: 'deliverable',
      content: 'Board migrated.',
    });
    expect([masterPost.seq, humanPost.seq, subordinatePost.seq]).toEqual([
      1, 2, 3,
    ]);
    expect(masterPost.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      files.listBoardEntriesSync({ sinceSeq: 1 }).map((entry) => entry.id),
    ).toEqual([humanPost.id, subordinatePost.id]);
    expect(
      files.listBoardEntriesSync({ limit: 2 }).map((entry) => entry.id),
    ).toEqual([humanPost.id, subordinatePost.id]);
    expect(files.getAgentBoardWatermarkSync(run.id)).toBe(0);
    await files.setAgentBoardWatermark(run.id, humanPost.seq);
    await files.setAgentBoardWatermark(run.id, masterPost.seq);
    expect(files.getAgentBoardWatermarkSync(run.id)).toBe(humanPost.seq);
    expect(
      files.listUnreadBoardCountsSync().find(
        (entry) => entry.agentRunId === run.id,
      )?.unreadCount,
    ).toBe(1);

    const normalMessage = files.createInboxMessageSync({
      fromAgentRunId: run.id,
      fromRole: 'master',
      toRole: 'frontend',
      kind: 'question',
      body: 'Is the Board ready?',
      waitToken: 'wait-board-ready',
      priority: 'normal',
    });
    const urgentMessage = files.createInboxMessageSync({
      fromAgentRunId: run.id,
      fromRole: 'master',
      toAgentRunId: subordinate.id,
      kind: 'notify',
      body: 'Stop SQLite writes.',
      priority: 'urgent',
    });
    expect(normalMessage.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalMessage.thread_id).toBe(normalMessage.id);
    expect(
      files.getInboxMessageByWaitTokenSync('wait-board-ready')?.id,
    ).toBe(normalMessage.id);
    expect(
      files.claimNextInboxForAgentSync({
        agentRunId: subordinate.id,
        role: 'frontend',
      })?.id,
    ).toBe(urgentMessage.id);
    expect(
      files.answerInboxMessageSync(urgentMessage.id, 'done'),
    ).toMatchObject({
      status: 'answered',
      answer: 'done',
    });
    const reply = files.createInboxMessageSync({
      fromAgentRunId: subordinate.id,
      fromRole: 'frontend',
      toAgentRunId: run.id,
      kind: 'notify',
      body: 'Board is ready.',
      threadId: normalMessage.id,
      replyToMessageId: normalMessage.id,
    });
    expect(reply.thread_id).toBe(normalMessage.id);
    expect(
      files.listInboxMessagesSync({
        fromAgentRunId: subordinate.id,
      }).map((message) => message.id),
    ).toEqual([reply.id]);

    const prompt = await files.createMasterPrompt({
      agent_run_id: run.id,
      kind: 'question',
      body: 'Deploy now?',
      options: [{ label: 'Yes', value: 'yes' }],
    });
    expect((await files.getPendingMasterPrompt('question'))?.id).toBe(
      prompt.id,
    );
    const firstClaim = await files.claimMasterPromptDelivery(
      prompt.id,
      'question',
      'delivery-1',
      'payload-hash',
    );
    expect(firstClaim.kind).toBe('claimed');
    expect(
      await files.releaseMasterPromptDelivery(prompt.id, 'delivery-1'),
    ).toBe(true);
    const secondClaim = await files.claimMasterPromptDelivery(
      prompt.id,
      'question',
      'delivery-2',
      'payload-hash',
    );
    expect(secondClaim.kind).toBe('claimed');
    expect(
      await files.completeMasterPromptDelivery(
        prompt.id,
        'delivery-2',
        { kind: 'question', answer: 'yes' },
      ),
    ).toMatchObject({
      id: prompt.id,
      status: 'answered',
      answer: 'yes',
    });

    const cancelled = await files.createMasterPrompt({
      agent_run_id: run.id,
      kind: 'plan',
      body: 'Plan',
    });
    expect(
      (await files.cancelPendingMasterPrompts()).map(
        (candidate) => candidate.id,
      ),
    ).toContain(cancelled.id);

    const blockerCard = files.createKanbanCardSync({
      title: 'Prepare filesystem schema',
      column: 'todo',
      checklist: ['Define UUID relationships'],
    });
    const implementationCard = files.createKanbanCardSync({
      title: 'Implement filesystem storage',
      column: 'todo',
    });
    const dependency = files.addKanbanDependencySync(
      implementationCard.id,
      blockerCard.id,
    );
    const assignment = files.assignKanbanAgentSync(
      implementationCard.id,
      subordinate.id,
      'frontend',
    );
    const comment = files.addKanbanCommentSync(
      implementationCard.id,
      'frontend',
      subordinate.id,
      'Filesystem implementation started.',
    );
    const checklist = files.updateKanbanChecklistSync(
      blockerCard.id,
      [{
        id: blockerCard.checklist[0]?.id,
        text: 'Define UUID relationships',
        checked: true,
      }],
    );
    expect(dependency.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(assignment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(comment.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(checklist[0]?.checked).toBe(true);
    expect(
      files.getKanbanCardFullSync(implementationCard.id)?.blocked_by,
    ).toEqual([blockerCard.id]);
    expect(() =>
      files.addKanbanDependencySync(
        blockerCard.id,
        implementationCard.id,
      ),
    ).toThrow(/creates a cycle/);
    expect(() => files.deleteKanbanCardSync(blockerCard.id)).toThrow(
      /still required/,
    );
    files.moveKanbanCardSync(blockerCard.id, 'done');
    expect(
      files.getKanbanCardFullSync(implementationCard.id)?.blocked_by,
    ).toEqual([]);
    expect(
      files.unassignKanbanAgentSync(
        implementationCard.id,
        subordinate.id,
      )?.unassigned_at,
    ).not.toBeNull();

    const restartedFiles = new CompanySessionFiles({
      companySessionId: asCompanySessionId(company.session.id),
      sessionStore: store,
    });
    expect(
      restartedFiles.listKanbanCardsFullSync().map((card) => card.id),
    ).toEqual([blockerCard.id, implementationCard.id]);
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      company.session.id,
      'company',
      'agent-runs',
      `${run.id}.json`,
    ));
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      company.session.id,
      'company',
      'master-prompts',
      `${prompt.id}.json`,
    ));
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      company.session.id,
      'company',
      'board-items',
      `${masterPost.id}.json`,
    ));
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      company.session.id,
      'company',
      'inbox-messages',
      `${normalMessage.id}.json`,
    ));
    await stat(join(
      projectRoot,
      '.mcp-indexer',
      'session',
      company.session.id,
      'company',
      'kanban-cards',
      `${implementationCard.id}.json`,
    ));
  });
});
