import { describe, it, expect, vi } from 'vitest';
import { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { PipelineNode } from '@mcp/company/types.js';

// Mock the only DB-touching value import so this test stays pure (no
// better-sqlite3). Branch output is keyed by coder session id.
const { OUTPUTS } = vi.hoisted(() => ({ OUTPUTS: {} as Record<number, string> }));
vi.mock('@mcp/company/services/finalText.js', () => ({
  readFinalAssistantText: (sid: number) => OUTPUTS[sid] ?? '',
}));

// Imported after the mock is registered (vi.mock is hoisted).
const { FanOutRunner } = await import('@mcp/company/services/pipeline-fanout.js');

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

describe('FanOutRunner', () => {
  it('spawns each project, retries a failed branch, then aggregates and joins', async () => {
    const attention = new MasterAttention();
    const barriers = new Map();

    // agentRunId → terminal status; branch 2 fails once, retry (id 3) passes.
    const STATUS: Record<number, string> = { 1: 'completed', 2: 'error', 3: 'completed' };
    OUTPUTS[10] = 'OUT-A';
    OUTPUTS[20] = '';
    OUTPUTS[30] = 'OUT-B';

    let agentSeq = 0;
    let rowSeq = 0;
    let cardSeq = 0;
    const nodeRows: Record<number, { status?: string; output?: string }> = {};

    const exec = {
      id: 1, pipeline_id: 7, status: 'running',
      context: { snapshot: { version: 1, nodes: [], edges: [] }, vars: {} },
    };
    const companyStore = {
      getPipelineExecution: () => exec,
      createPipelineNodeExecution: () => { rowSeq += 1; nodeRows[rowSeq] = {}; return { id: rowSeq }; },
      updatePipelineNodeExecution: (id: number, patch: { status?: string; output_text?: string }) => {
        nodeRows[id] = { ...nodeRows[id], ...patch };
      },
    };
    const ctx = {
      companyStore,
      projects: [
        { company_session_id: 1, project_id: 11, label: 'A' },
        { company_session_id: 1, project_id: 22, label: 'B' },
      ],
    };
    const kanban = { createCard: () => { cardSeq += 1; return { id: cardSeq }; }, assignAgent: () => {}, moveCard: () => {} };
    const subordinates = {
      spawn: async () => { agentSeq += 1; return { agentRunId: agentSeq, coderSessionId: agentSeq * 10, status: 'running' }; },
      statusOf: (agentRunId: number) => STATUS[agentRunId] ?? null,
      abort: () => true,
    };
    const publisher = { publish: vi.fn() };

    let joined: { aggregated: string; node: PipelineNode } | null = null;
    const failed = vi.fn();

    const runner = new FanOutRunner({
      // deps are structurally typed; the test doubles satisfy what the runner touches.
      ctx: ctx as never,
      kanban: kanban as never,
      subordinates: subordinates as never,
      attention,
      publisher: publisher as never,
      barriers,
      pipelineNameFor: async () => 'P',
      onJoin: (_executionId, node, aggregated) => { joined = { aggregated, node }; },
      failExecution: failed,
    });

    const node: PipelineNode = {
      id: 'fan', label: 'Fix', role: 'backend', taskTemplate: 'do {{initial_input}}',
      kind: 'fan-out', branchMode: 'linear', maxAttempts: 2,
      fanOut: { mode: 'each-project', role: 'backend' },
    };

    await runner.run(1, node, 'the-bug', '');
    expect(agentSeq).toBe(2); // one spawn per project
    expect(joined).toBeNull(); // nothing finished yet

    // Branch A (agent 1) completes.
    attention.signal({ kind: 'finished', agentRunId: 1, role: 'backend' });
    await flush();
    expect(joined).toBeNull(); // still waiting on B

    // Branch B (agent 2) fails → retry spawns agent 3.
    attention.signal({ kind: 'finished', agentRunId: 2, role: 'backend' });
    await flush();
    expect(agentSeq).toBe(3);
    expect(joined).toBeNull();

    // Retry (agent 3) completes → barrier drains → join.
    attention.signal({ kind: 'finished', agentRunId: 3, role: 'backend' });
    await flush();

    expect(failed).not.toHaveBeenCalled();
    expect(joined).not.toBeNull();
    const agg = joined!.aggregated;
    expect(agg).toContain('### A [ok]');
    expect(agg).toContain('OUT-A');
    expect(agg).toContain('### B [ok]');
    expect(agg).toContain('OUT-B');
    expect(barriers.size).toBe(0); // barrier cleaned up
  });

  it('marks a branch FAILED in the aggregate after exhausting retries (best-effort)', async () => {
    const attention = new MasterAttention();
    const barriers = new Map();
    OUTPUTS[10] = 'ok-out';

    let agentSeq = 0; let rowSeq = 0; let cardSeq = 0;
    const exec = { id: 1, pipeline_id: 7, status: 'running', context: { snapshot: { version: 1, nodes: [], edges: [] }, vars: {} } };
    const companyStore = {
      getPipelineExecution: () => exec,
      createPipelineNodeExecution: () => { rowSeq += 1; return { id: rowSeq }; },
      updatePipelineNodeExecution: () => {},
    };
    const ctx = { companyStore, projects: [{ company_session_id: 1, project_id: 11, label: 'A' }, { company_session_id: 1, project_id: 22, label: 'B' }] };
    const kanban = { createCard: () => { cardSeq += 1; return { id: cardSeq }; }, assignAgent: () => {}, moveCard: () => {} };
    const subordinates = {
      spawn: async () => { agentSeq += 1; return { agentRunId: agentSeq, coderSessionId: agentSeq * 10, status: 'running' }; },
      statusOf: (id: number) => (id === 1 ? 'completed' : 'error'),
      abort: () => true,
    };
    let joined: string | null = null;
    const runner = new FanOutRunner({
      ctx: ctx as never, kanban: kanban as never, subordinates: subordinates as never,
      attention, publisher: { publish: vi.fn() } as never, barriers,
      pipelineNameFor: async () => 'P',
      onJoin: (_e, _n, aggregated) => { joined = aggregated; },
      failExecution: vi.fn(),
    });

    const node: PipelineNode = {
      id: 'fan', label: 'Fix', role: 'backend', taskTemplate: 'x', kind: 'fan-out',
      branchMode: 'linear', maxAttempts: 1, // no retry
      fanOut: { mode: 'each-project', role: 'backend' },
    };

    await runner.run(1, node, 'bug', '');
    attention.signal({ kind: 'finished', agentRunId: 1, role: 'backend' });
    attention.signal({ kind: 'finished', agentRunId: 2, role: 'backend' });
    await flush();

    expect(joined).not.toBeNull();
    expect(joined!).toContain('### A [ok]');
    expect(joined!).toContain('### B [FALHOU]');
    expect(agentSeq).toBe(2); // no retry with maxAttempts=1
  });
});
