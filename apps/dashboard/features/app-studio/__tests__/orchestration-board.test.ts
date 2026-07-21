import { describe, expect, it } from 'vitest';
import type { AppWorkItemView } from '../app-studio-api.js';
import { currentWorkAttempt, groupAppWorkItems, recentEventKind, workRuntimeSummary } from '../AppStudioOrchestrationBoard.js';

function work(id: string, status: AppWorkItemView['status'], priority = 0): AppWorkItemView {
  return {
    id,
    app_session_id: 1,
    plan_revision_id: 4,
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
    const groups = groupAppWorkItems([
      work('done', 'done'),
      work('low-ready', 'ready', 10),
      work('running', 'running'),
      work('backlog', 'backlog'),
      work('high-ready', 'ready', 50),
      work('blocked', 'blocked'),
    ]);

    expect(groups.map((entry) => entry.group)).toEqual(['active', 'ready', 'blocked', 'queued', 'completed']);
    expect(groups[1]?.items.map((item) => item.id)).toEqual(['high-ready', 'low-ready']);
  });

  it('uses the live attempt first and tolerates history-only servers', () => {
    const item = work('foundation', 'running');
    item.latest_attempt = {
      id: 2, attempt: 1, role: 'fullstack', company_agent_run_id: 550, coder_session_id: 1277,
      status: 'running', status_message: 'Implementing', updated_at: '2026-07-19 01:10:00',
    };
    item.active_attempt = {
      ...item.latest_attempt,
      id: 3,
      attempt: 2,
      status_message: 'Verifying',
    };

    expect(currentWorkAttempt(item)).toMatchObject({ id: 3, attempt: 2, status_message: 'Verifying' });

    delete item.active_attempt;
    delete item.latest_attempt;
    item.attempts = [
      { id: 8, attempt: 1, role: 'fullstack', company_agent_run_id: null, coder_session_id: null, status: 'error', status_message: null, updated_at: '2026-07-19 01:00:00' },
      { id: 9, attempt: 2, role: 'fullstack', company_agent_run_id: 550, coder_session_id: 1277, status: 'running', status_message: null, updated_at: '2026-07-19 01:10:00' },
    ];
    expect(currentWorkAttempt(item)).toMatchObject({ id: 9, attempt: 2 });
  });

  it('accepts canonical and preview event kind fields', () => {
    expect(recentEventKind({ id: 1, kind: 'work.status', created_at: '2026-07-19 01:00:00' })).toBe('work.status');
    expect(recentEventKind({ id: 2, event_type: 'agents.specialist_dispatched', created_at: '2026-07-19 01:00:00' })).toBe('agents.specialist_dispatched');
  });

  it('recovers the agent and attempt from durable dispatch events on older detail payloads', () => {
    const item = work('foundation', 'running');
    expect(workRuntimeSummary(item, [{
      id: 12,
      event_type: 'agents.specialist_dispatched',
      payload: { work_item_id: 'foundation', role: 'fullstack', attempt: 2, company_agent_run_id: 550 },
      created_at: '2026-07-19 01:00:00',
    }])).toEqual({ role: 'fullstack', agentRunId: 550, attempt: 2 });
  });
});
