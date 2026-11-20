/**
 * A child's usage counts in its parent exactly once, descendants included.
 * The children's worker writes their run records and conclusions (holding
 * their leases); the parent's own store writes the parent's metrics. Covered:
 * waiting twice, a parent restart between conclusion and accounting, the same
 * conclusion received by a wait and by a background notice, a grandchild
 * finishing after its parent concluded, and a conclusion seen before its run
 * record completed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { buildConclusion } from '../child-agent-conclusion.js';
import { ChildAgentUsageLedger, childRunUsageKey, type ChildAgentClaim } from '../child-agent-usage.js';
import { childFixture, type ChildFixture } from './child-agent-fixture.js';

let f: ChildFixture;
const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

/** The child's worker: one run, its conclusion, then its record completion (unless `complete` is false). */
async function run(childId: string, used: ReturnType<typeof usage>, complete = true) {
  await f.worker.refresh();
  const runId = randomUUID();
  const fence = await f.worker.startSubagentRun({ session_id: childId as never, run_id: runId, profile: 'explore', max_turns: 0 });
  await f.worker.recordChildAgentConclusion(childId, buildConclusion({ runId, state: 'completed', reason: 'completed',
    finalText: 'Done.', changedFiles: ['src/a.ts'], usage: used }));
  const completeRecord = () => f.worker.completeSubagentRun({ run_id: runId, reason: 'completed', turns: 1, auto_continues: 0,
    tool_calls: 0, logical_operations: 0, productive_operations: 0, paginate_calls: 0, duplicate_calls: 0, error_calls: 0,
    refused_calls: 0, elapsed_ms: 1, ...used, has_summary: true, fence });
  if (complete) await completeRecord();
  return { runId, completeRecord };
}

/** The ledger of `parentId`'s run, writing through `store` (the parent's own writer). */
function ledger(store: FsSessionStore = f.app, parentId = f.rootId) {
  return new ChildAgentUsageLedger(parentId, {
    sessions: { getChildAgentSession: (id) => store.getChildAgentSession(id), listChildAgentSessions: (id) => store.listChildAgentSessions(id),
      listSubagentRuns: (id, offset, limit) => store.listSubagentRuns(id, offset, limit), refreshSession: (id) => store.refreshSession(id) },
    accounted: () => store.listAccountedSubagentKeys(parentId),
    recordStandalone: (used, key) => store.bumpSessionUsage(parentId, used, key),
  });
}
/** The parent's turn that received a claim, written like runCoder's flush. */
const persistTurn = (claim: Pick<ChildAgentClaim, 'usage' | 'keys'>, store: FsSessionStore = f.app, id = f.rootId) =>
  store.persistAssistantTurn({ session_id: id as never, message: { role: 'assistant', content: [{ type: 'text', text: 'Received.' }] },
    usage: null, tool_calls: [], subagent_usage: claim.usage ?? undefined, subagent_runs: claim.keys });
const tokens = async (store: FsSessionStore = f.app, id = f.rootId) => {
  await store.refreshSession(id);
  const { input, output } = (await store.getMetricsSummary(id)).tokens;
  return { input, output };
};

beforeEach(async () => { f = await childFixture('child-agent-usage-'); });
afterEach(async () => { await f.close(); });

describe('child-agent usage in the parent', () => {
  it('counts a waited-for run once in the turn, also when waited for twice and after a restart', async () => {
    const x = await f.child(f.rootId, 'x');
    await f.holdLease(x);
    const { runId } = await run(x, usage(100, 20));
    const parent = ledger();
    const claim = await parent.claimForTurn([x]);
    expect(claim).toMatchObject({ usage: usage(100, 20), keys: [childRunUsageKey(runId)] });
    expect((await parent.claimForTurn([x])).usage).toBeNull(); // the second wait
    await persistTurn(claim);
    await f.restart();
    await f.holdLease(x);
    expect((await ledger().claimForTurn([x])).usage).toBeNull();
    expect(await ledger().sweep()).toEqual([]);
    expect(await tokens()).toEqual({ input: 100, output: 20 });
    expect([...await f.app.listAccountedSubagentKeys(f.rootId)]).toEqual([childRunUsageKey(runId)]);
  });

  it('counts a run once as standalone usage when the parent restarted before its turn was written', async () => {
    const x = await f.child(f.rootId, 'x');
    await f.holdLease(x);
    await run(x, usage(70, 7));
    expect((await ledger().claimForTurn([x])).usage).toEqual(usage(70, 7)); // the turn is lost with the worker
    await f.restart();
    await f.holdLease(x);
    expect((await ledger().sweep()).map((found) => found.usage)).toEqual([usage(70, 7)]);
    expect(await ledger().sweep()).toEqual([]);
    expect(await tokens()).toEqual({ input: 70, output: 7 });
  });

  it('counts a conclusion received by a wait and by a background notice once, in either order', async () => {
    const [x, y] = [await f.child(f.rootId, 'x'), await f.child(f.rootId, 'y')];
    for (const id of [x, y]) await f.holdLease(id);
    await run(x, usage(10, 1));
    await run(y, usage(20, 2));
    const parent = ledger();
    const waited = await parent.claimForTurn([x]);
    await persistTurn(waited);
    expect((await parent.sweep()).map((found) => found.childId)).toEqual([y]); // the notice of x adds nothing
    expect((await parent.claimForTurn([y])).usage).toBeNull(); // nor does a later wait for y
    expect(await tokens()).toEqual({ input: 30, output: 3 });
  });

  it('includes descendants, and counts a grandchild that finished after its parent concluded once in each ancestor', async () => {
    const x = await f.child(f.rootId, 'x');
    await f.holdLease(x);
    const g = await f.child(x, 'g');
    await f.holdLease(g);
    const late = await f.child(x, 'late');
    await f.holdLease(late);
    await run(g, usage(5, 1));
    await run(x, usage(50, 10));
    const parent = ledger();
    const claim = await parent.claimForTurn([x]);
    expect(claim.usage).toEqual(usage(55, 11));
    await persistTurn(claim);
    // The late grandchild finishes after x concluded and after the root counted x's subtree.
    await run(late, usage(3, 3));
    expect((await parent.sweep()).map((found) => found.childId)).toEqual([late]);
    expect(await parent.sweep()).toEqual([]);
    expect(await tokens()).toEqual({ input: 58, output: 14 });
    // x's own worker counts its children once in x's totals.
    const own = ledger(f.worker, x);
    expect((await own.sweep()).map((found) => found.childId).sort()).toEqual([g, late].sort());
    expect(await ledger(f.worker, x).sweep()).toEqual([]);
    expect(await tokens(f.worker, x)).toEqual({ input: 8, output: 4 });
  });

  it("finds children the app created after the parent's worker store scanned, through discovery", async () => {
    // The parent's worker: its own store instance, scanned before the child existed.
    const parentWorker = FsSessionStore.fromRoots({ dataDir: f.dataDir, projectRootResolver: {
      resolveProjectRoot: (id) => f.project(id)?.root_path, listProjectRoots: () => [{ project_id: 1, root_path: f.project(1)!.root_path }] } });
    try {
      expect(await parentWorker.getSession(f.rootId)).not.toBeNull();
      const x = await f.child(f.rootId, 'x');
      await f.holdLease(x);
      await run(x, usage(21, 3));
      const view = (discover: boolean) => new ChildAgentUsageLedger(f.rootId, {
        sessions: { getChildAgentSession: (id) => parentWorker.getChildAgentSession(id), listChildAgentSessions: (id) => parentWorker.listChildAgentSessions(id),
          listSubagentRuns: (id, offset, limit) => parentWorker.listSubagentRuns(id, offset, limit), refreshSession: (id) => parentWorker.refreshSession(id),
          ...(discover ? { discoverNewSessions: () => parentWorker.discoverNewSessions() } : {}) },
        accounted: async () => new Set(), recordStandalone: async () => undefined,
      });
      expect((await view(false).claimForTurn([x])).usage).toBeNull(); // the gap: the child is invisible to this store
      expect((await view(true).claimForTurn([x])).usage).toEqual(usage(21, 3));
    } finally { await parentWorker.close(); }
  });

  it('counts a run from its conclusion before the run record completes, and not again after', async () => {
    const x = await f.child(f.rootId, 'x');
    await f.holdLease(x);
    const { completeRecord } = await run(x, usage(40, 4), false);
    const parent = ledger();
    const claim = await parent.claimForTurn([x]);
    expect(claim.usage).toEqual(usage(40, 4));
    await persistTurn(claim);
    await completeRecord();
    expect(await parent.sweep()).toEqual([]);
    expect(await ledger().sweep()).toEqual([]);
    expect(await tokens()).toEqual({ input: 40, output: 4 });
  });
});
