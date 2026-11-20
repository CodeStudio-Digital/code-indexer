/**
 * A child chat's conclusion, when its parent receives it (the usage ledger's
 * claim or sweep), is recorded as an investigation of the parent, as
 * spawn_agent's results were: once, for the parent's own children only, for
 * completed and cut-off runs with a final answer, never in Company.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../core/tool.js';
import { MICRO_AGENT_PROFILES } from '../../tools/micro-agent-profiles.js';
import { captureChildInvestigations } from '../child-agent-investigations.js';
import { createChildAgentAccounting } from '../child-agent-freshness.js';
import type { ChildAgentRunUsage } from '../child-agent-usage.js';

const usage = { input_tokens: 30, output_tokens: 12 };
const run = (childId: string, runId = `${childId}-r1`): ChildAgentRunUsage => ({ key: `k:${runId}`, childId, runId, usage, changedFiles: [] });
const conclusion = (runId: string, state = 'completed', final_text: string | null = `Findings of ${runId}.`) =>
  ({ run_id: runId, state, reason: state, finished_at: '', final_text, changed_files: [], usage });

function fixture(children: Record<string, { parent: string; profile?: string; conclusion: ReturnType<typeof conclusion> | null }>) {
  const recordInvestigation = vi.fn(async (input: Record<string, unknown>) => ({ id: 'i', ...input }));
  const sessions = {
    getChildAgentSession: vi.fn(async (id: string) => children[id] ? { id, parent_session_id: children[id]!.parent, depth: 1,
      profile: children[id]!.profile ?? 'explore', read_only: false, conclusion: children[id]!.conclusion } : null),
    getSession: vi.fn(async (id: string) => ({ id, title: `Title of ${id}` })),
    recordInvestigation,
  };
  const emit = vi.fn();
  const ctx = { cwd: '.', projectName: 'p', runner: { sessionId: 'parent', emit } } as unknown as ToolContext;
  return { deps: { parentId: 'parent', sessions: sessions as never }, ctx, recordInvestigation, emit };
}

describe('child-chat investigations', () => {
  it('records a received conclusion of its own child, as spawn_agent did', async () => {
    const { deps, ctx, recordInvestigation, emit } = fixture({ c1: { parent: 'parent', conclusion: conclusion('c1-r1') } });
    expect(await captureChildInvestigations(deps, ctx, [run('c1')])).toBe(1);
    expect(recordInvestigation).toHaveBeenCalledWith({ session_id: 'parent', topic: 'Title of c1', summary: 'Findings of c1-r1.',
      body: 'Findings of c1-r1.', source_label: 'Title of c1', agent_type: MICRO_AGENT_PROFILES.explore.capability, tokens: 42 });
    expect(emit).toHaveBeenCalledWith('session_drive_changed', { kind: 'investigation' });
  });

  it('records completed and cut-off runs with an answer, nothing else', async () => {
    const { deps, ctx, recordInvestigation } = fixture({
      cut: { parent: 'parent', profile: 'implement', conclusion: conclusion('cut-r1', 'cut_off') },
      failed: { parent: 'parent', conclusion: conclusion('failed-r1', 'failed') },
      aborted: { parent: 'parent', conclusion: conclusion('aborted-r1', 'aborted') },
      silent: { parent: 'parent', conclusion: conclusion('silent-r1', 'completed', '  ') },
      grandchild: { parent: 'cut', conclusion: conclusion('grandchild-r1') },
      older: { parent: 'parent', conclusion: conclusion('older-r2') },
      pending: { parent: 'parent', conclusion: null },
    });
    const runs = ['cut', 'failed', 'aborted', 'silent', 'grandchild', 'older', 'pending', 'unknown'].map((id) => run(id));
    expect(await captureChildInvestigations(deps, ctx, runs)).toBe(1);
    expect(recordInvestigation).toHaveBeenCalledTimes(1);
    expect(recordInvestigation.mock.calls[0]![0]).toMatchObject({ topic: 'Title of cut', agent_type: MICRO_AGENT_PROFILES.implement.capability });
  });

  it('records nothing in Company', async () => {
    const { deps, ctx, recordInvestigation } = fixture({ c1: { parent: 'parent', conclusion: conclusion('c1-r1') } });
    await captureChildInvestigations(deps, { ...ctx, companyContext: {} } as never, [run('c1')]);
    expect(recordInvestigation).not.toHaveBeenCalled();
  });

  it('captures through the accounting on both receiving paths, once per newly counted run', async () => {
    const { deps, ctx, recordInvestigation } = fixture({ a: { parent: 'parent', conclusion: conclusion('a-r1') }, b: { parent: 'parent', conclusion: conclusion('b-r1') } });
    let claimed: ChildAgentRunUsage[] = [run('a')];
    const ledger = { claimForTurn: vi.fn(async () => ({ usage, keys: claimed.map((item) => item.key), runs: claimed })), sweep: vi.fn(async () => [run('b')]) };
    const accounting = createChildAgentAccounting({ ledger: ledger as never, toolContext: ctx, investigations: deps });
    await accounting.claim(['a']);
    claimed = []; // the ledger counts a run once
    await accounting.claim(['a']);
    await accounting.sweep();
    expect(recordInvestigation.mock.calls.map((call) => call[0].summary)).toEqual(['Findings of a-r1.', 'Findings of b-r1.']);
    const without = createChildAgentAccounting({ ledger: { claimForTurn: async () => ({ usage, keys: [], runs: [run('a')] }), sweep: async () => [] } as never, toolContext: ctx });
    await without.claim(['a']);
    expect(recordInvestigation).toHaveBeenCalledTimes(2);
  });
});
