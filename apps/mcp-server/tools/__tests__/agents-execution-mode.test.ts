import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpAgentSessionCreatePayload,
  parseMcpAgentExecutionMode,
} from '../../agent-run-contract.js';
import { agentTools } from '../agents.js';

const { startRun } = vi.hoisted(() => ({
  startRun: vi.fn().mockResolvedValue({ id: 'run-1', sessionId: 42 }),
}));

vi.mock('../../agent-run-manager.js', () => ({
  getMcpAgentRunManager: () => ({ start: startRun }),
}));

const baseInput = {
  projectName: 'MCP',
  task: 'Inspect the repository',
  agentId: 'investigator',
  provider: 'openai',
  model: 'gpt-5.6',
};

describe('start_agent_run execution mode', () => {
  it('advertises the standard|ultra MCP schema independently from native effort', () => {
    const tool = agentTools.find((candidate) => candidate.name === 'start_agent_run');
    expect(tool).toBeDefined();
    const properties = tool!.inputSchema.properties as Record<string, Record<string, unknown>>;

    expect(properties.execution_mode).toMatchObject({
      type: 'string',
      enum: ['standard', 'ultra'],
      default: 'standard',
    });
    expect(properties.reasoning_effort).toMatchObject({ type: 'string' });
  });

  it('propagates execution_mode and a provider-native reasoning effort to session creation', () => {
    expect(buildMcpAgentSessionCreatePayload({
      ...baseInput,
      executionMode: 'ultra',
      reasoningEffort: ' high ',
    }, 42)).toEqual({
      project_id: 42,
      title: 'MCP: Inspect the repository',
      provider: 'openai',
      model: 'gpt-5.6',
      agent: 'investigator',
      execution_mode: 'ultra',
      reasoning_effort: 'high',
    });
  });

  it('maps the public tool arguments onto the run-manager contract', async () => {
    const tool = agentTools.find((candidate) => candidate.name === 'start_agent_run')!;

    await tool.handler({
      project_name: 'MCP',
      task: 'Inspect the repository',
      agent_id: 'investigator',
      provider: 'openai',
      model: 'gpt-5.6',
      execution_mode: 'ultra',
      reasoning_effort: 'high',
    }, {} as never);

    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      executionMode: 'ultra',
      reasoningEffort: 'high',
    }), undefined);
  });

  it('defaults new MCP runs to standard mode', () => {
    expect(buildMcpAgentSessionCreatePayload(baseInput, 42)).toMatchObject({
      execution_mode: 'standard',
    });
  });

  it('lets an explicit MCP mode win while stripping the legacy sentinel', () => {
    const payload = buildMcpAgentSessionCreatePayload({
      ...baseInput,
      executionMode: 'standard',
      reasoningEffort: ' ULTRA ',
    }, 42);

    expect(payload.execution_mode).toBe('standard');
    expect(payload).not.toHaveProperty('reasoning_effort');
  });

  it('converts legacy reasoning_effort=ultra when execution_mode is absent', () => {
    const payload = buildMcpAgentSessionCreatePayload({
      ...baseInput,
      reasoningEffort: ' ULTRA ',
    }, 42);

    expect(payload.execution_mode).toBe('ultra');
    expect(payload).not.toHaveProperty('reasoning_effort');
  });

  it('rejects invalid direct/in-process execution modes', () => {
    expect(parseMcpAgentExecutionMode('ultra')).toBe('ultra');
    expect(parseMcpAgentExecutionMode(undefined)).toBeUndefined();
    expect(() => parseMcpAgentExecutionMode('turbo')).toThrow(/standard, ultra/);
    expect(() => parseMcpAgentExecutionMode('')).toThrow(/standard, ultra/);
  });
});
