import { describe, it, expect, vi } from 'vitest';
import { buildMasterTools } from '@mcp/company/tools/master-tools.js';
import type { CompanyOrchestrator } from '@mcp/company/orchestrator.js';
import type { ToolContext } from '@mcp/code-agent/core/tool.js';

const ctx: ToolContext = { cwd: '/tmp', projectName: 'test' };

interface CapturedSpec {
  role: string;
  task: string;
  deepThink?: boolean;
  deepThinkModel?: string;
  deepThinkProvider?: string;
  preThinkOnToolResults?: boolean;
}

function makeOrchestrator(opts: {
  roleDefaults: {
    deepThink?: boolean;
    deepThinkModel?: string;
    deepThinkProvider?: string;
    preThinkOnToolResults?: boolean;
  } | null;
  captured: { spec: CapturedSpec | null };
}): CompanyOrchestrator {
  return {
    getRoleDefaults: () => opts.roleDefaults,
    spawnSubordinate: vi.fn(async (spec: CapturedSpec) => {
      opts.captured.spec = spec;
      return { agentRunId: 1, coderSessionId: 1, status: 'running' };
    }),
    getMasterLastUserAttachments: () => [],
    kanbanCreateCard: vi.fn(),
    kanbanAddComment: vi.fn(),
    getCardContextForSubordinate: () => null,
  } as unknown as CompanyOrchestrator;
}

function getSpawnTool(orchestrator: CompanyOrchestrator) {
  const tools = buildMasterTools(orchestrator);
  const tool = tools.find((t) => t.name === 'spawn_subordinate_agent');
  if (!tool) throw new Error('spawn_subordinate_agent not found');
  return tool;
}

describe('spawn_subordinate_agent — deepThink propagation', () => {
  it('forwards deep_think arg as spec.deepThink', async () => {
    const captured: { spec: CapturedSpec | null } = { spec: null };
    const orch = makeOrchestrator({
      roleDefaults: { deepThink: false },
      captured,
    });
    const tool = getSpawnTool(orch);
    await tool.handler({
      role: 'frontend',
      task: 'add a button to the dashboard with proper accessibility',
      deep_think: true,
    }, ctx);
    expect(captured.spec).not.toBeNull();
    expect(captured.spec!.deepThink).toBe(true);
  });

  it('falls back to roleConfig.deepThink when master omits deep_think', async () => {
    const captured: { spec: CapturedSpec | null } = { spec: null };
    const orch = makeOrchestrator({
      roleDefaults: {
        deepThink: true,
        deepThinkModel: 'claude-haiku-4-5-20251001',
        deepThinkProvider: 'anthropic',
      },
      captured,
    });
    const tool = getSpawnTool(orch);
    await tool.handler({
      role: 'backend',
      task: 'refactor the auth middleware to use the new token storage',
    }, ctx);
    expect(captured.spec!.deepThink).toBe(true);
    expect(captured.spec!.deepThinkModel).toBe('claude-haiku-4-5-20251001');
    expect(captured.spec!.deepThinkProvider).toBe('anthropic');
  });

  it('arg overrides role default (master can disable per-spawn)', async () => {
    const captured: { spec: CapturedSpec | null } = { spec: null };
    const orch = makeOrchestrator({
      roleDefaults: { deepThink: true, deepThinkModel: 'claude-haiku-4-5-20251001' },
      captured,
    });
    const tool = getSpawnTool(orch);
    await tool.handler({
      role: 'qa',
      task: 'run the smoke tests and report the failures with stack traces',
      deep_think: false,
    }, ctx);
    expect(captured.spec!.deepThink).toBe(false);
    // role-level fields still propagate even though deepThink was overridden off
    expect(captured.spec!.deepThinkModel).toBe('claude-haiku-4-5-20251001');
  });

  it('exposes deep_think in the JSON schema so the master sees it as an option', () => {
    const captured: { spec: CapturedSpec | null } = { spec: null };
    const orch = makeOrchestrator({ roleDefaults: null, captured });
    const tool = getSpawnTool(orch);
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.deep_think).toBeDefined();
    expect((props.deep_think as { type: string }).type).toBe('boolean');
  });
});
