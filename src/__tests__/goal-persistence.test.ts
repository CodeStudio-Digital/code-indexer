import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
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

  function ctxFor(sid: number): ToolContext {
    return {
      cwd: workDir,
      projectName: 'test-proj',
      // Mark the runner as present so create/update don't bail on
      // "requires runner context"; the persistence callbacks below take
      // priority over the WeakMap fallback.
      runner: {} as unknown as ToolContext['runner'],
      getGoalState: () => store.getSessionGoal(sid),
      upsertGoalState: (g) => store.upsertSessionGoal(sid, g),
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

  it('persists status=complete across runners', async () => {
    await createGoal.handler({ goal: 'ship release v2' }, ctxFor(sessionId));
    const u = await updateGoal.handler({ status: 'complete', note: 'tagged v2.0.0' }, ctxFor(sessionId));
    expect(u.isError).toBeFalsy();

    const fresh = ctxFor(sessionId);
    const g = await getGoal.handler({}, fresh);
    expect(g.content).toContain('complete');
    expect(g.content).toContain('tagged v2.0.0');
  });

  it('replace_active=false is currently ignored — supersede happens regardless (user disabled the strict branch in goal.ts)', async () => {
    // Historical: this test asserted the strict refusal path. The user
    // commented out the `if (!replaceActive)` block to make create_goal
    // always supersede. Test now mirrors the live behaviour.
    await createGoal.handler({ goal: 'first' }, ctxFor(sessionId));
    const fresh = ctxFor(sessionId);
    const r = await createGoal.handler({ goal: 'second', replace_active: false }, fresh);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('superseded');
  });

  it('auto-supersedes a persisted in-progress goal by default and persists the new one', async () => {
    await createGoal.handler({ goal: 'phase 1' }, ctxFor(sessionId));
    const fresh = ctxFor(sessionId);
    // No replace_active arg → default true → auto-replace.
    const r = await createGoal.handler({ goal: 'phase 2' }, fresh);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('superseded');

    // The new goal is what survives a runner restart.
    const fresh2 = ctxFor(sessionId);
    const g = await getGoal.handler({}, fresh2);
    expect(g.content).toContain('Goal: phase 2');
    expect(g.content).toContain('in_progress');
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
