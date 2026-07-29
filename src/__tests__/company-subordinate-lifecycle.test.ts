import { describe, it, expect, vi } from 'vitest';
import {
  resolveSpawnProjectBinding,
  SubordinateLifecycle,
} from '@mcp/company/services/SubordinateLifecycle.js';

vi.mock('@mcp/docs-agent/bridges/docs-bridge.js', () => ({
  installDocsDeepResearch: vi.fn(),
}));

const COMPANY_SESSION_ID = '00000000-0000-4000-8000-000000000042';
const MASTER_RUN_ID = '00000000-0000-4000-8000-000000000010';
const FRONTEND_RUN_ID = '00000000-0000-4000-8000-000000000020';
const STOPPED_RUN_ID = '00000000-0000-4000-8000-000000000005';
const UNKNOWN_RUN_ID = '00000000-0000-4000-8000-000000000099';
const ABORT_RUN_ID = '00000000-0000-4000-8000-000000000123';
const MASTER_SESSION_ID = '00000000-0000-4000-8000-000000000201';
const FRONTEND_SESSION_ID = '00000000-0000-4000-8000-000000000202';

describe('resolveSpawnProjectBinding', () => {
  describe('role with no project binding', () => {
    it('requires an explicit project id', () => {
      expect(() =>
        resolveSpawnProjectBinding({ role: 'frontend', specProjectId: undefined, boundProjectIds: [] }),
      ).toThrow(/no project binding/);
    });

    it('passes through the explicit id', () => {
      expect(
        resolveSpawnProjectBinding({ role: 'frontend', specProjectId: 42, boundProjectIds: [] }),
      ).toBe(42);
    });
  });

  describe('role bound to exactly one project', () => {
    it('auto-resolves when no project id is supplied', () => {
      expect(
        resolveSpawnProjectBinding({ role: 'frontend', specProjectId: undefined, boundProjectIds: [7] }),
      ).toBe(7);
    });

    it('accepts the matching id explicitly', () => {
      expect(
        resolveSpawnProjectBinding({ role: 'frontend', specProjectId: 7, boundProjectIds: [7] }),
      ).toBe(7);
    });

    it('rejects a non-matching id with the bound id named in the message', () => {
      expect(() =>
        resolveSpawnProjectBinding({ role: 'frontend', specProjectId: 9, boundProjectIds: [7] }),
      ).toThrow(/bound to project 7/);
    });
  });

  describe('role bound to multiple projects', () => {
    it('requires an explicit choice', () => {
      expect(() =>
        resolveSpawnProjectBinding({
          role: 'frontend',
          specProjectId: undefined,
          boundProjectIds: [1, 2, 3],
        }),
      ).toThrow(/bound to multiple projects \[1, 2, 3\]/);
    });

    it('accepts an id from the bound set', () => {
      expect(
        resolveSpawnProjectBinding({
          role: 'frontend',
          specProjectId: 2,
          boundProjectIds: [1, 2, 3],
        }),
      ).toBe(2);
    });

    it('rejects an id outside the bound set, listing the allowed ids', () => {
      expect(() =>
        resolveSpawnProjectBinding({
          role: 'frontend',
          specProjectId: 99,
          boundProjectIds: [1, 2, 3],
        }),
      ).toThrow(/bound to projects \[1, 2, 3\]/);
    });
  });

  it('names the role in every error message (helps master autocorrect)', () => {
    expect(() =>
      resolveSpawnProjectBinding({ role: 'qa', specProjectId: undefined, boundProjectIds: [] }),
    ).toThrow(/Role 'qa'/);
    expect(() =>
      resolveSpawnProjectBinding({ role: 'qa', specProjectId: 99, boundProjectIds: [1] }),
    ).toThrow(/Role 'qa'/);
    expect(() =>
      resolveSpawnProjectBinding({ role: 'qa', specProjectId: undefined, boundProjectIds: [1, 2] }),
    ).toThrow(/Role 'qa'/);
    expect(() =>
      resolveSpawnProjectBinding({ role: 'qa', specProjectId: 99, boundProjectIds: [1, 2] }),
    ).toThrow(/Role 'qa'/);
  });
});

// ─── ISubordinateQuery + lifecycle setters ───────────────────────

function makeLifecycle(): SubordinateLifecycle {
  // We can construct the service even though we'll never call `spawn` —
  // the public read-only surface (`runningCount`, `isRunning`, `get`,
  // `list`, `statusOf`) only needs the store-facing deps. The rest of
  // the deps are typed but unused for these tests.
  const listAgentRuns = () => [];
  const getAgentRun = () => null;
  const deps = {
    ctx: {
      companySessionId: COMPANY_SESSION_ID,
      companyFiles: {
        listAgentRunsSync: listAgentRuns,
        getAgentRunSync: getAgentRun,
      },
    },
    board: {},
    status: {},
    kanban: {},
    master: {},
    humanInLoop: {},
    wirer: {},
    idle: {},
    orchestratorRef: {},
    attention: {},
  } as never;
  return new SubordinateLifecycle(deps);
}

describe('SubordinateLifecycle — queries', () => {
  it('runningCount starts at 0 when no subordinates have spawned', () => {
    const lc = makeLifecycle();
    expect(lc.runningCount).toBe(0);
  });

  it('isRunning is false for an unknown agentRunId', () => {
    const lc = makeLifecycle();
    expect(lc.isRunning(UNKNOWN_RUN_ID)).toBe(false);
  });

  it('get returns undefined for an unknown agentRunId', () => {
    const lc = makeLifecycle();
    expect(lc.get(UNKNOWN_RUN_ID)).toBeUndefined();
  });

  it('list returns empty when the agent_runs table has no entries', () => {
    const lc = makeLifecycle();
    expect(lc.list()).toEqual([]);
  });

  it('list filters out the master role and projects fields', () => {
    const runs = [
      {
        id: MASTER_RUN_ID,
        role: 'master',
        status: 'running',
        status_message: '',
        project_ids_json: '[1]',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        coder_session_id: MASTER_SESSION_ID,
      },
      {
        id: FRONTEND_RUN_ID,
        role: 'frontend',
        status: 'waiting',
        status_message: 'queued',
        project_ids_json: '[2, 3]',
        provider: 'anthropic',
        model: 'claude-haiku-4-5',
        coder_session_id: FRONTEND_SESSION_ID,
      },
    ];
    const deps = {
      ctx: {
        companySessionId: COMPANY_SESSION_ID,
        companyFiles: {
          listAgentRunsSync: () => runs,
          getAgentRunSync: () => null,
        },
      },
      board: {}, status: {}, kanban: {}, master: {}, humanInLoop: {},
      wirer: {}, idle: {}, orchestratorRef: {}, attention: {},
    } as never;
    const lc = new SubordinateLifecycle(deps);
    const result = lc.list();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      agentRunId: FRONTEND_RUN_ID,
      role: 'frontend',
      status: 'waiting',
      statusMessage: 'queued',
      projectIds: [2, 3],
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      coderSessionId: FRONTEND_SESSION_ID,
      isAlive: false,
    });
  });

  it('statusOf returns null when the agent run does not exist', () => {
    const lc = makeLifecycle();
    expect(lc.statusOf(UNKNOWN_RUN_ID)).toBeNull();
  });

  it('statusOf reads through to the company store', () => {
    const deps = {
      ctx: {
        companySessionId: COMPANY_SESSION_ID,
        companyFiles: {
          listAgentRunsSync: () => [],
          getAgentRunSync: (id: string) =>
            id === STOPPED_RUN_ID ? { status: 'aborted' } : null,
        },
      },
      board: {}, status: {}, kanban: {}, master: {}, humanInLoop: {},
      wirer: {}, idle: {}, orchestratorRef: {}, attention: {},
    } as never;
    const lc = new SubordinateLifecycle(deps);
    expect(lc.statusOf(STOPPED_RUN_ID)).toBe('aborted');
    expect(lc.statusOf(UNKNOWN_RUN_ID)).toBeNull();
  });

  it('abort returns false when no subordinate matches', () => {
    const lc = makeLifecycle();
    expect(lc.abort(ABORT_RUN_ID)).toBe(false);
  });

  it('finalizeAll is a no-op with empty state (but still calls clearAll on humanInLoop + posts a system message)', () => {
    const clearAll = vi.fn();
    const post = vi.fn();
    const deps = {
      ctx: {
        companySessionId: COMPANY_SESSION_ID,
        companyFiles: {
          listAgentRunsSync: () => [],
          getAgentRunSync: () => null,
        },
      },
      board: { post },
      status: {}, kanban: {}, master: {},
      humanInLoop: { clearAll },
      wirer: {}, idle: {}, orchestratorRef: {}, attention: {},
    } as never;
    const lc = new SubordinateLifecycle(deps);
    expect(lc.finalizeAll()).toEqual({ finalized: 0, alreadyStopped: 0 });
    expect(clearAll).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      'system',
      null,
      'message',
      expect.stringContaining('0 stopped'),
    );
  });
});

describe('SubordinateLifecycle — setOnSubordinateIdle', () => {
  it('persists the callback on deps for late-binding by the orchestrator', () => {
    const lc = makeLifecycle();
    const cb = () => undefined;
    // No error means the late-bind setter accepted the callback. Spawn
    // flows would later invoke it via deps.onSubordinateIdle, but
    // covering that requires the runCoder integration harness.
    expect(() => lc.setOnSubordinateIdle(cb)).not.toThrow();
  });
});
