import { describe, it, expect, vi } from 'vitest';
import { buildMasterTools } from '../core/coder/tools/company/master-tools.js';
import type { CoderTool, ToolContext } from '../core/coder/core/tool.js';
import type { CompanyOrchestrator } from '../core/coder/company/orchestrator.js';

const ctx: ToolContext = { cwd: '/tmp', projectName: 'test' };

interface FakeOrchOpts {
  pendingPlan?: number[];
  pendingQuestion?: number[];
  pendingTasks?: number[];
  abortable?: number[];
  forwardable?: Map<number, { role: string; running: boolean }>;
}

function makeFakeOrch(opts: FakeOrchOpts = {}) {
  const pendingPlan = new Set(opts.pendingPlan ?? []);
  const pendingQuestion = new Set(opts.pendingQuestion ?? []);
  const pendingTasks = new Set(opts.pendingTasks ?? []);
  const abortable = new Set(opts.abortable ?? []);
  const forwardable = opts.forwardable ?? new Map();

  return {
    hasPendingPlan: vi.fn((id: number) => pendingPlan.has(id)),
    hasPendingQuestion: vi.fn((id: number) => pendingQuestion.has(id)),
    hasPendingTasks: vi.fn((id: number) => pendingTasks.has(id)),
    resolveSubordinatePlan: vi.fn(() => true),
    resolveSubordinateQuestion: vi.fn(() => true),
    resolveSubordinateTasks: vi.fn(() => true),
    abortSubordinate: vi.fn((id: number) => abortable.has(id)),
    listSubordinates: vi.fn(() => []),
    listProjects: vi.fn(() => []),
    getMasterLastUserAttachments: vi.fn(() => []),
    postToBoard: vi.fn(),
    getSubordinate: vi.fn((id: number) => {
      const f = forwardable.get(id);
      if (!f) return undefined;
      return { role: f.role, runner: { pushUserMessage: vi.fn(), pushUserContent: vi.fn() } };
    }),
    getSubordinateStatus: vi.fn(),
    isSubordinateRunning: vi.fn((id: number) => forwardable.get(id)?.running ?? false),
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
    const orch = makeFakeOrch({ pendingPlan: [7] });
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_plan');
    const r = await tool.handler({ agent_run_id: 7, approved: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('approved');
  });

  it('approve_subordinate_plan accepts path', async () => {
    const orch = makeFakeOrch({ pendingPlan: [7] });
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_plan');
    const r = await tool.handler({ path: '/root/master/qa-7', approved: false, feedback: 'redo' }, ctx);
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
    const orch = makeFakeOrch({ pendingQuestion: [11] });
    const tool = findTool(buildMasterTools(orch), 'answer_subordinate_question');
    const r = await tool.handler({ path: '/root/master/frontend-11', answer: 'use the new API' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Question answered for agent 11');
  });

  it('approve_subordinate_tasks accepts path', async () => {
    const orch = makeFakeOrch({ pendingTasks: [3] });
    const tool = findTool(buildMasterTools(orch), 'approve_subordinate_tasks');
    const r = await tool.handler({ path: '/root/master/be-3', approved: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('approved');
  });

  it('abort_subordinate_agent accepts path', async () => {
    const orch = makeFakeOrch({ abortable: [42] });
    const tool = findTool(buildMasterTools(orch), 'abort_subordinate_agent');
    const r = await tool.handler({ path: '/root/master/qa-42' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('aborted');
  });

  it('forward_to_agent accepts path', async () => {
    const forwardable = new Map([[7, { role: 'qa', running: true }]]);
    const orch = makeFakeOrch({ forwardable });
    const tool = findTool(buildMasterTools(orch), 'forward_to_agent');
    const r = await tool.handler({ path: '/root/master/qa-7', message: 'rerun the tests' }, ctx);
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
