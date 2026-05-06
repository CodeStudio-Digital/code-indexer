import { describe, it, expect, vi } from 'vitest';
import { buildSpawnAgentTool } from '../core/coder/tools/spawn-agent.js';
import { ToolRegistry } from '../core/coder/core/registry.js';
import type { CoderTool, ToolContext } from '../core/coder/core/tool.js';

const ctx: ToolContext = { cwd: '/tmp', projectName: 'test' };

function fakeTool(name: string, handler: CoderTool['handler']): CoderTool {
  return {
    name,
    description: `${name} fake`,
    source: 'native',
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    handler,
  };
}

describe('spawn_agent — wrapper dispatch', () => {
  it('dispatches kind="ephemeral" to spawn_subagent with default type', async () => {
    const subHandler = vi.fn(async (args: Record<string, unknown>) => ({
      content: `subagent received type=${args.type} task=${args.task}`,
    }));
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subagent', subHandler));
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'ephemeral', task: 'find foo' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('type=explore');
    expect(r.content).toContain('task=find foo');
    expect(subHandler).toHaveBeenCalledTimes(1);
    const calledWith = subHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith.type).toBe('explore');
    expect(calledWith.task).toBe('find foo');
  });

  it('dispatches kind="ephemeral" with explicit type and max_turns', async () => {
    const subHandler = vi.fn(async (args: Record<string, unknown>) => ({
      content: JSON.stringify(args),
    }));
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subagent', subHandler));
    const wrapper = buildSpawnAgentTool(registry);
    await wrapper.handler({ kind: 'ephemeral', task: 't', type: 'explore', max_turns: 5 }, ctx);
    const args = subHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(args.type).toBe('explore');
    expect(args.max_turns).toBe(5);
  });

  it('errors on kind="ephemeral" when spawn_subagent is absent', async () => {
    const registry = new ToolRegistry();
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'ephemeral', task: 't' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('spawn_subagent is not available');
  });

  it('dispatches kind="persistent" to spawn_subordinate_agent with all relevant fields', async () => {
    const subHandler = vi.fn(async (args: Record<string, unknown>) => ({
      content: `spawned role=${args.role} project=${args.project_id} wait=${args.wait}`,
    }));
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subordinate_agent', subHandler));
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({
      kind: 'persistent',
      role: 'frontend',
      task: 'add a button',
      project_id: 3,
      tier: 'navigate',
      wait: true,
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('role=frontend');
    expect(r.content).toContain('project=3');
    expect(r.content).toContain('wait=true');
    const calledWith = subHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(calledWith.role).toBe('frontend');
    expect(calledWith.task).toBe('add a button');
    expect(calledWith.project_id).toBe(3);
    expect(calledWith.tier).toBe('navigate');
    expect(calledWith.wait).toBe(true);
  });

  it('errors on kind="persistent" when neither spawn_subordinate_agent nor spawn_subagent are available', async () => {
    const registry = new ToolRegistry();
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'persistent', role: 'qa', task: 't' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('neither');
  });

  it('routes kind="persistent" outside Company to spawn_subagent type=implement', async () => {
    const subHandler = vi.fn(async (a: Record<string, unknown>) => ({ content: `routed type=${a.type} files=${JSON.stringify(a.files)}` }));
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subagent', subHandler));
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({
      kind: 'persistent',
      task: 'fix the layout',
      files: ['src/app/foo.ts', 'src/app/foo.css'],
      max_turns: 80,
    }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('type=implement');
    const args = subHandler.mock.calls[0][0] as Record<string, unknown>;
    expect(args.type).toBe('implement');
    expect(args.task).toBe('fix the layout');
    expect(args.files).toEqual(['src/app/foo.ts', 'src/app/foo.css']);
    expect(args.max_turns).toBe(80);
  });

  it('errors on kind="persistent" without role inside a Company master session', async () => {
    const subHandler = vi.fn();
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subordinate_agent', subHandler));
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'persistent', task: 't' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('requires `role`');
    expect(subHandler).not.toHaveBeenCalled();
  });

  it('errors on empty task', async () => {
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subagent', async () => ({ content: 'x' })));
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'ephemeral', task: '   ' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('task cannot be empty');
  });

  it('propagates errors from the underlying spawn tool', async () => {
    const subHandler = async () => ({ content: 'underlying boom', isError: true });
    const registry = new ToolRegistry();
    registry.register(fakeTool('spawn_subagent', subHandler));
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'ephemeral', task: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('underlying boom');
  });

  it('rejects unknown kind', async () => {
    const registry = new ToolRegistry();
    const wrapper = buildSpawnAgentTool(registry);
    const r = await wrapper.handler({ kind: 'zombie', task: 't' } as Record<string, unknown>, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('unknown kind');
  });
});
