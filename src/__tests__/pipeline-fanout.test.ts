import { describe, it, expect, vi } from 'vitest';
import { MasterAttention } from '@mcp/company/services/MasterAttention.js';
import type { PipelineNode } from '@mcp/company/types.js';

// Mock the only DB-touching value import so this test stays pure (no
// better-sqlite3). Branch output is keyed by coder session id.
const { OUTPUTS } = vi.hoisted(() => ({ OUTPUTS: {} as Record<string, string> }));
vi.mock('@mcp/company/services/finalText.js', () => ({
  readFinalAssistantText: (_store: unknown, sid: string) => OUTPUTS[sid] ?? '',
}));

// Imported after the mock is registered (vi.mock is hoisted).
const { FanOutRunner } = await import('@mcp/company/services/pipeline-fanout.js');

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

const EXECUTION_ID = '00000000-0000-4000-8000-000000000001';
const COMPANY_ID = '00000000-0000-4000-8000-000000000002';
const AGENT_IDS = [
  '00000000-0000-4000-8000-000000000011',
  '00000000-0000-4000-8000-000000000012',
  '00000000-0000-4000-8000-000000000013',
] as const;
const CODER_IDS = [
  '00000000-0000-4000-8000-000000000021',
  '00000000-0000-4000-8000-000000000022',
  '00000000-0000-4000-8000-000000000023',
] as const;
const ROW_IDS = [
  '00000000-0000-4000-8000-000000000031',
  '00000000-0000-4000-8000-000000000032',
  '00000000-0000-4000-8000-000000000033',
] as const;
const CARD_IDS = [
  '00000000-0000-4000-8000-000000000041',
  '00000000-0000-4000-8000-000000000042',
] as const;

describe('FanOutRunner', () => {
  it('spawns each project, retries a failed branch, then aggregates and joins', async () => {
    const attention = new MasterAttention();
    const barriers = new Map();

    // agentRunId → terminal status; branch 2 fails once, retry (id 3) passes.
    const STATUS: Record<string, string> = {
      [AGENT_IDS[0]]: 'completed',
      [AGENT_IDS[1]]: 'error',
      [AGENT_IDS[2]]: 'completed',
    };
    OUTPUTS[CODER_IDS[0]] = 'OUT-A';
    OUTPUTS[CODER_IDS[1]] = '';
    OUTPUTS[CODER_IDS[2]] = 'OUT-B';

    let agentSeq = 0;
    let rowSeq = 0;
    let cardSeq = 0;
    const nodeRows: Record<string, { status?: string; output?: string }> = {};

    const exec = {
      id: EXECUTION_ID, pipeline_id: 7, status: 'running',
      context: { snapshot: { version: 1, nodes: [], edges: [] }, vars: {} },
    };
    const companyStore = {
      getPipelineExecution: () => exec,
      createPipelineNodeExecution: () => {
        const id = ROW_IDS[rowSeq++]!;
        nodeRows[id] = {};
        return { id };
      },
      updatePipelineNodeExecution: (id: string, patch: { status?: string; output_text?: string }) => {
        nodeRows[id] = { ...nodeRows[id], ...patch };
      },
    };
    const ctx = {
      companyStore,
      companyFiles: { sessionStore: {} },
      projects: [
        { company_session_id: COMPANY_ID, project_id: 11, label: 'A' },
        { company_session_id: COMPANY_ID, project_id: 22, label: 'B' },
      ],
    };
    const kanban = {
      createCard: () => ({ id: CARD_IDS[cardSeq++]! }),
      assignAgent: () => {},
      moveCard: () => {},
    };
    const subordinates = {
      spawn: async () => {
        const index = agentSeq++;
        return {
          agentRunId: AGENT_IDS[index]!,
          coderSessionId: CODER_IDS[index]!,
          status: 'running',
        };
      },
      statusOf: (agentRunId: string) => STATUS[agentRunId] ?? null,
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

    await runner.run(EXECUTION_ID, node, 'the-bug', '');
    expect(agentSeq).toBe(2); // one spawn per project
    expect(joined).toBeNull(); // nothing finished yet

    // Branch A (agent 1) completes.
    attention.signal({ kind: 'finished', agentRunId: AGENT_IDS[0], role: 'backend' });
    await flush();
    expect(joined).toBeNull(); // still waiting on B

    // Branch B (agent 2) fails → retry spawns agent 3.
    attention.signal({ kind: 'finished', agentRunId: AGENT_IDS[1], role: 'backend' });
    await flush();
    expect(agentSeq).toBe(3);
    expect(joined).toBeNull();

    // Retry (agent 3) completes → barrier drains → join.
    attention.signal({ kind: 'finished', agentRunId: AGENT_IDS[2], role: 'backend' });
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
    OUTPUTS[CODER_IDS[0]] = 'ok-out';

    let agentSeq = 0; let rowSeq = 0; let cardSeq = 0;
    const exec = { id: EXECUTION_ID, pipeline_id: 7, status: 'running', context: { snapshot: { version: 1, nodes: [], edges: [] }, vars: {} } };
    const companyStore = {
      getPipelineExecution: () => exec,
      createPipelineNodeExecution: () => ({ id: ROW_IDS[rowSeq++]! }),
      updatePipelineNodeExecution: () => {},
    };
    const ctx = {
      companyStore,
      companyFiles: { sessionStore: {} },
      projects: [
        { company_session_id: COMPANY_ID, project_id: 11, label: 'A' },
        { company_session_id: COMPANY_ID, project_id: 22, label: 'B' },
      ],
    };
    const kanban = { createCard: () => ({ id: CARD_IDS[cardSeq++]! }), assignAgent: () => {}, moveCard: () => {} };
    const subordinates = {
      spawn: async () => {
        const index = agentSeq++;
        return { agentRunId: AGENT_IDS[index]!, coderSessionId: CODER_IDS[index]!, status: 'running' };
      },
      statusOf: (id: string) => (id === AGENT_IDS[0] ? 'completed' : 'error'),
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

    await runner.run(EXECUTION_ID, node, 'bug', '');
    attention.signal({ kind: 'finished', agentRunId: AGENT_IDS[0], role: 'backend' });
    attention.signal({ kind: 'finished', agentRunId: AGENT_IDS[1], role: 'backend' });
    await flush();

    expect(joined).not.toBeNull();
    expect(joined!).toContain('### A [ok]');
    expect(joined!).toContain('### B [FALHOU]');
    expect(agentSeq).toBe(2); // no retry with maxAttempts=1
  });
});
