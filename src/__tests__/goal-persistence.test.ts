import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SessionStore } from '@mcp/code-agent/sessions/store.js';
import { goalTools } from '@mcp/code-agent/tools/goal.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const createGoal = goalTools.find((t) => t.name === 'create_goal')!;
const getGoal = goalTools.find((t) => t.name === 'get_goal')!;
const updateGoal = goalTools.find((t) => t.name === 'update_goal')!;

describe('goal — DB-persisted across runner restarts', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let store: SessionStore;
  let projectId: number;
  let sessionId: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'goal-persist-'));
    const dbPath = join(workDir, 'index.sqlite');
    db = new CodeIndexDB(dbPath);
    store = new SessionStore(dbPath);
    const project = db.createProject('test-proj', workDir);
    projectId = project.id;
  });

  afterAll(() => {
    store.close();
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Each test gets its own session row to start without contamination.
    sessionId = store.createSession({
      project_id: projectId,
      title: 'goal test',
      provider: 'anthropic',
      model: 'sonnet',
    }).id;
  });

  function ctxFor(
    sid: number,
    goalLifecycleIntent?: ToolContext['goalLifecycleIntent'],
    goalLifecyclePivotGoalCreatedAt?: string,
  ): ToolContext {
    return {
      cwd: workDir,
      projectName: 'test-proj',
      // Mark the runner as present so create/update don't bail on
      // "requires runner context"; the persistence callbacks below take
      // priority over the WeakMap fallback.
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => store.getSessionGoal(sid),
      upsertGoalState: (g) => store.upsertSessionGoal(sid, g),
      goalLifecycleIntent,
      goalLifecyclePivotGoalCreatedAt,
    };
  }

  it('returns "(no goal set)" before anything was persisted', async () => {
    const r = await getGoal.handler({}, ctxFor(sessionId));
    expect(r.content).toBe('(no goal set)');
  });

  it('persists a created goal across fresh ToolContexts (runner restart simulation)', async () => {
    const c = await createGoal.handler({ goal: 'Migrate auth to OAuth2', budget_tokens: 50000 }, ctxFor(sessionId));
    expect(c.isError).toBeFalsy();

    // Brand new ctx — simulates a fresh runner reading the resumed session
    const fresh = ctxFor(sessionId);
    const g = await getGoal.handler({}, fresh);
    expect(g.isError).toBeFalsy();
    expect(g.content).toContain('Migrate auth to OAuth2');
    expect(g.content).toContain('in_progress');
    expect(g.content).toContain('50000');
  });

  it('returns a tool error when synchronous goal persistence throws', async () => {
    const ctx: ToolContext = {
      cwd: workDir,
      projectName: 'test-proj',
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => null,
      upsertGoalState: () => {
        throw new Error('synchronous SQL failure');
      },
    };

    const result = await createGoal.handler({ goal: 'must persist' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('create_goal: failed to persist goal state');
    expect(result.content).toContain('synchronous SQL failure');
    expect(result.content).not.toContain('Goal set');
  });

  it('refuses to overwrite goal state when the persisted read fails', async () => {
    const upsertGoalState = vi.fn();
    const ctx: ToolContext = {
      cwd: workDir,
      projectName: 'test-proj',
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => {
        throw new Error('SQLITE_BUSY while reading goal');
      },
      upsertGoalState,
    };

    const result = await createGoal.handler({ goal: 'must not overwrite' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('create_goal: failed to read persisted goal state');
    expect(result.content).toContain('SQLITE_BUSY');
    expect(upsertGoalState).not.toHaveBeenCalled();
  });

  it('surfaces persisted read failures from get_goal and update_goal', async () => {
    const ctx: ToolContext = {
      cwd: workDir,
      projectName: 'test-proj',
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => {
        throw new Error('goal database unavailable');
      },
      upsertGoalState: vi.fn(),
    };

    const readResult = await getGoal.handler({}, ctx);
    const updateResult = await updateGoal.handler({ status: 'complete' }, ctx);

    expect(readResult).toMatchObject({ isError: true });
    expect(readResult.content).toContain('get_goal: failed to read persisted goal state');
    expect(updateResult).toMatchObject({ isError: true });
    expect(updateResult.content).toContain('update_goal: failed to read persisted goal state');
  });

  it('awaits asynchronous goal persistence and returns a tool error on rejection', async () => {
    const ctx: ToolContext = {
      cwd: workDir,
      projectName: 'test-proj',
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => null,
      upsertGoalState: async () => {
        await Promise.resolve();
        throw new Error('asynchronous SQL failure');
      },
    };

    const result = await createGoal.handler({ goal: 'must await persistence' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('create_goal: failed to persist goal state');
    expect(result.content).toContain('asynchronous SQL failure');
    expect(result.content).not.toContain('Goal set');
  });

  it('returns a tool error when completing a goal cannot be persisted', async () => {
    const now = new Date().toISOString();
    const ctx: ToolContext = {
      cwd: workDir,
      projectName: 'test-proj',
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => ({
        text: 'finish safely',
        status: 'in_progress',
        budgetTokens: null,
        completionNote: null,
        createdAt: now,
        updatedAt: now,
      }),
      upsertGoalState: async () => {
        throw new Error('completion write rejected');
      },
    };

    const result = await updateGoal.handler({ status: 'complete' }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('update_goal: failed to persist goal state');
    expect(result.content).toContain('completion write rejected');
    expect(result.content).not.toContain('Goal marked complete');
  });

  it('throws when goal persistence targets a missing session row', () => {
    const now = new Date().toISOString();
    const missingSessionId = sessionId + 1_000_000_000;

    expect(() => store.upsertSessionGoal(missingSessionId, {
      text: 'orphan goal',
      status: 'in_progress',
      budgetTokens: null,
      completionNote: null,
      createdAt: now,
      updatedAt: now,
    })).toThrow(`upsertSessionGoal: session ${missingSessionId} was not found`);
  });

  it('persists status=complete across runners', async () => {
    await createGoal.handler({ goal: 'ship release v2' }, ctxFor(sessionId));
    const u = await updateGoal.handler({ status: 'complete', note: 'tagged v2.0.0' }, ctxFor(sessionId));
    expect(u.isError).toBeFalsy();

    const fresh = ctxFor(sessionId);
    const g = await getGoal.handler({}, fresh);
    expect(g.content).toContain('complete');
    expect(g.content).toContain('tagged v2.0.0');
  });

  it('refuses a redundant create against a persisted in_progress goal (no silent supersede)', async () => {
    // create_goal stays visible the whole run now (prompt-cache prefix
    // stability), so the handler refuses a second create while a goal is
    // in_progress instead of auto-superseding it.
    await createGoal.handler({ goal: 'first' }, ctxFor(sessionId));
    const fresh = ctxFor(sessionId);
    const r = await createGoal.handler({ goal: 'second' }, fresh);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('already in_progress');
    // The original persisted goal is untouched.
    const fresh2 = ctxFor(sessionId);
    const g = await getGoal.handler({}, fresh2);
    expect(g.content).toContain('Goal: first');
    expect(g.content).toContain('in_progress');
  });

  it('allows a pivot only after completing the persisted goal first', async () => {
    await createGoal.handler({ goal: 'phase 1' }, ctxFor(sessionId));
    await updateGoal.handler({ status: 'complete' }, ctxFor(sessionId));
    const r = await createGoal.handler({ goal: 'phase 2' }, ctxFor(sessionId));
    expect(r.isError).toBeFalsy();

    // The new goal is what survives a runner restart.
    const fresh2 = ctxFor(sessionId);
    const g = await getGoal.handler({}, fresh2);
    expect(g.content).toContain('Goal: phase 2');
    expect(g.content).toContain('in_progress');
  });

  it('supersedes an unfinished goal only with explicit pivot authority and an audit note', async () => {
    await createGoal.handler({ goal: 'old objective' }, ctxFor(sessionId));
    const inheritedCreatedAt = store.getSessionGoal(sessionId)!.createdAt;

    const unauthorized = await updateGoal.handler(
      { status: 'superseded', note: 'user changed scope' },
      ctxFor(sessionId),
    );
    expect(unauthorized).toMatchObject({ isError: true });
    expect(unauthorized.content).toContain('explicit user pivot');

    const missingReason = await updateGoal.handler(
      { status: 'superseded' },
      ctxFor(sessionId, 'required_pivot', inheritedCreatedAt),
    );
    expect(missingReason).toMatchObject({ isError: true });
    expect(missingReason.content).toContain('requires a short reason');

    const superseded = await updateGoal.handler(
      { status: 'superseded', note: 'User requested a different objective.' },
      ctxFor(sessionId, 'required_pivot', inheritedCreatedAt),
    );
    expect(superseded.isError).toBeFalsy();
    expect(store.getSessionGoal(sessionId)).toMatchObject({
      status: 'superseded',
      completionNote: 'User requested a different objective.',
    });

    const replacement = await createGoal.handler(
      { goal: 'replacement objective' },
      ctxFor(sessionId, 'required_pivot', inheritedCreatedAt),
    );
    expect(replacement.isError).toBeFalsy();
    expect(store.getSessionGoal(sessionId)).toMatchObject({
      text: 'replacement objective',
      status: 'in_progress',
    });

    const replacementGoal = store.getSessionGoal(sessionId)!;
    store.upsertSessionGoal(sessionId, {
      ...replacementGoal,
      createdAt: '2099-01-01T00:00:00.000Z',
      updatedAt: '2099-01-01T00:00:00.000Z',
    });
    const cannotSupersedeReplacement = await updateGoal.handler(
      { status: 'superseded', note: 'agent changed its mind again' },
      ctxFor(sessionId, 'required_pivot', inheritedCreatedAt),
    );
    expect(cannotSupersedeReplacement).toMatchObject({ isError: true });
    expect(cannotSupersedeReplacement.content).toContain('only the inherited goal');
  });

  it('isolates goal per session (sessionA does not see sessionB goal)', async () => {
    const sessionA = sessionId;
    const sessionB = store.createSession({
      project_id: projectId, title: 'B', provider: 'anthropic', model: 'sonnet',
    }).id;

    await createGoal.handler({ goal: 'goal A' }, ctxFor(sessionA));
    const gB = await getGoal.handler({}, ctxFor(sessionB));
    expect(gB.content).toBe('(no goal set)');

    await createGoal.handler({ goal: 'goal B' }, ctxFor(sessionB));
    const gA = await getGoal.handler({}, ctxFor(sessionA));
    expect(gA.content).toContain('goal A');
    const gB2 = await getGoal.handler({}, ctxFor(sessionB));
    expect(gB2.content).toContain('goal B');
  });

  it('clearSessionGoal wipes the persisted state', async () => {
    await createGoal.handler({ goal: 'temporary' }, ctxFor(sessionId));
    store.clearSessionGoal(sessionId);
    const g = await getGoal.handler({}, ctxFor(sessionId));
    expect(g.content).toBe('(no goal set)');
  });

  it('get_goal nudges the model to stop polling once goal is complete', async () => {
    await createGoal.handler({ goal: 'finished' }, ctxFor(sessionId));
    await updateGoal.handler({ status: 'complete' }, ctxFor(sessionId));
    const g = await getGoal.handler({}, ctxFor(sessionId));
    expect(g.content).toContain('complete');
    expect(g.content).toContain('Do NOT call get_goal again');
    expect(g.content.toLowerCase()).toContain('end the run');
  });
});
