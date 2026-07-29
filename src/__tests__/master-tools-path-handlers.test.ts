import { describe, it, expect, vi } from 'vitest';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';

const ctx: ToolContext = { cwd: '/tmp', projectName: 'test' };
const ID_3 = '00000003-0000-4000-8000-000000000003';
const ID_7 = '00000007-0000-4000-8000-000000000007';
const ID_11 = '00000011-0000-4000-8000-000000000011';
const ID_42 = '00000042-0000-4000-8000-000000000042';

interface FakeOrchOpts {
  pendingPlan?: string[];
  pendingQuestion?: string[];
  pendingTasks?: string[];
  abortable?: string[];
  forwardable?: Map<string, { role: string; running: boolean }>;
}

function makeFakeOrch(opts: FakeOrchOpts = {}) {
  const pendingPlan = new Set(opts.pendingPlan ?? []);
  const pendingQuestion = new Set(opts.pendingQuestion ?? []);
  const pendingTasks = new Set(opts.pendingTasks ?? []);
  const abortable = new Set(opts.abortable ?? []);
  const forwardable = opts.forwardable ?? new Map();

  return {
    hasPendingPlan: vi.fn((id: string) => pendingPlan.has(id)),
    hasPendingQuestion: vi.fn((id: string) => pendingQuestion.has(id)),
    hasPendingTasks: vi.fn((id: string) => pendingTasks.has(id)),
    resolveSubordinatePlan: vi.fn(() => true),
    resolveSubordinateQuestion: vi.fn(() => true),
    resolveSubordinateTasks: vi.fn(() => true),
    abortSubordinate: vi.fn((id: string) => abortable.has(id)),
    listSubordinates: vi.fn(() => []),
    listProjects: vi.fn(() => []),
    getMasterLastUserAttachments: vi.fn(() => []),
    postToBoard: vi.fn(),
    getSubordinate: vi.fn((id: string) => {
      const f = forwardable.get(id);
      if (!f) return undefined;
      return { role: f.role, runner: { pushUserMessage: vi.fn(), pushUserContent: vi.fn() } };
    }),
    getSubordinateStatus: vi.fn(),
    isSubordinateRunning: vi.fn((id: string) => forwardable.get(id)?.running ?? false),
    reactivateSubordinate: vi.fn(async () => true),
  } as unknown as CompanyOrchestrator;
}

function findTool(tools: CoderTool[], name: string): CoderTool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe('master tools — path | agent_run_id parity', () => {
  it('approve_subordinate_plan accepts agent_run_id', async () => {
    const orch = makeFakeOrch({ pendingPlan: [ID_7] });
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_plan');
    const r = await tool.handler({ agent_run_id: ID_7, approved: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('approved');
  });

  it('approve_subordinate_plan accepts path', async () => {
    const orch = makeFakeOrch({ pendingPlan: [ID_7] });
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_plan');
    const r = await tool.handler({ path: `/root/master/qa-${ID_7}`, approved: false, feedback: 'redo' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('rejected');
    expect(r.content).toContain('redo');
  });

  it('approve_subordinate_plan errors when neither is provided', async () => {
    const orch = makeFakeOrch();
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_plan');
    const r = await tool.handler({ approved: true }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('agent_run_id');
    expect(r.content).toContain('path');
  });

  it('answer_subordinate_question accepts path', async () => {
    const orch = makeFakeOrch({ pendingQuestion: [ID_11] });
    const tool = findTool(buildMasterTools(orch), 'answer_subordinate_question');
    const r = await tool.handler({ path: `/root/master/frontend-${ID_11}`, answer: 'use the new API' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`Question answered for agent ${ID_11}`);
  });

  it('approve_subordinate_tasks accepts path', async () => {
    const orch = makeFakeOrch({ pendingTasks: [ID_3] });
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_tasks');
    const r = await tool.handler({ path: `/root/master/be-${ID_3}`, approved: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('approved');
  });

  it('abort_subordinate_agent accepts path', async () => {
    const orch = makeFakeOrch({ abortable: [ID_42] });
    const tool = findTool(buildMasterTools(orch), 'abort_subordinate_agent');
    const r = await tool.handler({ path: `/root/master/qa-${ID_42}` }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('aborted');
  });

  it('forward_to_agent accepts path', async () => {
    const forwardable = new Map([[ID_7, { role: 'qa', running: true }]]);
    const orch = makeFakeOrch({ forwardable });
    const tool = findTool(buildMasterTools(orch), 'forward_to_agent');
    const r = await tool.handler({ path: `/root/master/qa-${ID_7}`, message: 'rerun the tests' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('forwarded');
  });

  it('all 5 tools surface a clear error when both inputs are missing', async () => {
    const orch = makeFakeOrch();
    const tools = buildMasterTools(orch);
    const targets = [
      { name: 'approve_subordinate_plan', extra: { approved: true } },
      { name: 'answer_subordinate_question', extra: { answer: 'x' } },
      { name: 'approve_subordinate_tasks', extra: { approved: true } },
      { name: 'abort_subordinate_agent', extra: {} },
      { name: 'forward_to_agent', extra: { message: 'hi' } },
    ];
    for (const t of targets) {
      const tool = findTool(tools, t.name);
      const r = await tool.handler(t.extra, ctx);
      expect(r.isError, `${t.name} should error without target`).toBe(true);
      expect(r.content).toContain('agent_run_id');
    }
  });
});
