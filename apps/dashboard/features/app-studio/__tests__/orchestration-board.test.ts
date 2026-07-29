import { describe, expect, it } from 'vitest';
import type { AppWorkItemView } from '../app-studio-api.js';
import { currentWorkAttempt, groupAppWorkItems, recentEventKind, workRuntimeSummary } from '../AppStudioOrchestrationBoard.js';

function uuid(value: number): string {
  return `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
}

const APP_ID = uuid(1);
const REVISION_ID = uuid(2);

function work(id: string, status: AppWorkItemView['status'], priority = 0): AppWorkItemView {
  return {
    id,
    seq: 1,
    app_session_id: APP_ID,
    plan_revision_id: REVISION_ID,
    slice_id: null,
    title: id,
    outcome: '',
    kind: 'implement',
    owner_role: 'fullstack',
    priority,
    status,
    sort_order: 0,
    depends_on: [],
    source_ids: [],
    acceptance: [],
    evidence: [],
    file_scope: [],
    blocked_reason: null,
    created_at: '2026-07-19 01:00:00',
    updated_at: '2026-07-19 01:00:00',
  };
}

describe('App Studio orchestration board', () => {
  it('prioritizes active and actionable work over the backlog and history', () => {
    const doneId = uuid(10);
    const lowReadyId = uuid(11);
    const runningId = uuid(12);
    const backlogId = uuid(13);
    const highReadyId = uuid(14);
    const blockedId = uuid(15);
    const groups = groupAppWorkItems([
      work(doneId, 'done'),
      work(lowReadyId, 'ready', 10),
      work(runningId, 'running'),
      work(backlogId, 'backlog'),
      work(highReadyId, 'ready', 50),
      work(blockedId, 'blocked'),
    ]);

    expect(groups.map((entry) => entry.group)).toEqual(['active', 'ready', 'blocked', 'queued', 'completed']);
    expect(groups[1]?.items.map((item) => item.id)).toEqual([highReadyId, lowReadyId]);
  });

  it('uses the live attempt first and tolerates history-only servers', () => {
    const item = work(uuid(20), 'running');
    item.latest_attempt = {
      id: uuid(21), seq: 1, attempt: 1, role: 'fullstack', company_agent_run_id: uuid(22), coder_session_id: uuid(23),
      status: 'running', status_message: 'Implementing', updated_at: '2026-07-19 01:10:00',
    };
    item.active_attempt = {
      ...item.latest_attempt,
      id: uuid(24),
      seq: 2,
      attempt: 2,
      status_message: 'Verifying',
    };

    expect(currentWorkAttempt(item)).toMatchObject({ id: uuid(24), attempt: 2, status_message: 'Verifying' });

    delete item.active_attempt;
    delete item.latest_attempt;
    item.attempts = [
      { id: uuid(25), seq: 3, attempt: 1, role: 'fullstack', company_agent_run_id: null, coder_session_id: null, status: 'error', status_message: null, updated_at: '2026-07-19 01:00:00' },
      { id: uuid(26), seq: 4, attempt: 2, role: 'fullstack', company_agent_run_id: uuid(22), coder_session_id: uuid(23), status: 'running', status_message: null, updated_at: '2026-07-19 01:10:00' },
    ];
    expect(currentWorkAttempt(item)).toMatchObject({ id: uuid(26), attempt: 2 });
  });

  it('accepts canonical and preview event kind fields', () => {
    expect(recentEventKind({ id: uuid(30), seq: 1, kind: 'work.status', created_at: '2026-07-19 01:00:00' })).toBe('work.status');
    expect(recentEventKind({ id: uuid(31), seq: 2, event_type: 'agents.specialist_dispatched', created_at: '2026-07-19 01:00:00' })).toBe('agents.specialist_dispatched');
  });

  it('recovers the agent and attempt from durable dispatch events on older detail payloads', () => {
    const item = work(uuid(40), 'running');
    expect(workRuntimeSummary(item, [{
      id: uuid(41),
      seq: 12,
      event_type: 'agents.specialist_dispatched',
      payload: { work_item_id: item.id, role: 'fullstack', attempt: 2, company_agent_run_id: uuid(42) },
      created_at: '2026-07-19 01:00:00',
    }])).toEqual({ role: 'fullstack', agentRunId: uuid(42), attempt: 2 });
  });
});
