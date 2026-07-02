import { describe, expect, it } from 'vitest';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import { runSubagent } from '../implement-subagent.js';

function captureProvider(): ChatProvider {
  let turn = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    setModel() {},
    async *chat(): AsyncIterable<ChatDelta> {
      turn++;
      if (turn === 1) {
        yield { type: 'tool_call_start', id: 'tu_capture', name: 'capture_context' };
        yield { type: 'tool_call_end', id: 'tu_capture', name: 'capture_context', input: {} };
        yield { type: 'done', stop_reason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'done' };
      yield { type: 'done', stop_reason: 'end_turn' };
    },
  };
}

describe('runSubagent context inheritance', () => {
  it('passes global workspace and execution context fields to subagent tools', async () => {
    let seenContext: ToolContext | undefined;
    const captureTool: CoderTool = {
      name: 'capture_context',
      description: 'capture context',
      parameters: { type: 'object', properties: {} },
      source: 'native',
      handler: async (_args, ctx) => {
        seenContext = ctx;
        return { content: 'captured' };
      },
    };

    const overlayByRoot = new Map();
    const ports = { fs: { kind: 'fs-port' }, shell: { kind: 'shell-port' } } as unknown as ToolContext['ports'];
    const runtimeEnv = { env: { PHP_VERSION: '8.3' } } as unknown as ToolContext['runtimeEnv'];
    const globalWorkspace: NonNullable<ToolContext['globalWorkspace']> = {
      syntheticProjectName: '__global_abc',
      rootPath: '/tmp/global',
      projects: [{
        projectId: 11,
        name: 'Backend Loyalty',
        slug: 'backend_loyalty',
        rootPath: '/repo/backend',
        isPrimary: true,
      }],
    };

    const parentContext = {
      cwd: '/tmp/global',
      projectName: '__global_abc',
      globalWorkspace,
      roots: [{ projectId: 12, name: 'Intranet', slug: 'intranet', rootPath: '/repo/intranet' }],
      overlayByRoot,
      projectId: 99,
      projectIndexed: true,
      runtimeEnv,
      ports,
      sessionId: 1234,
    } as ToolContext;

    const result = await runSubagent(
      {
        provider: captureProvider(),
        tools: [captureTool],
        ctx: parentContext,
        sessionId: 1234,
      },
      {
        systemPrompt: 'You are a test subagent.',
        allowlist: null,
        initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'capture' }] }],
        maxTurns: 5,
        limits: { maxToolCalls: 0, timeoutMs: 5_000, stallMs: 5_000 },
      },
    );

    expect(result.reason).toBe('completed');
    expect(seenContext?.cwd).toBe('/tmp/global');
    expect(seenContext?.projectName).toBe('__global_abc');
    expect(seenContext?.globalWorkspace).toBe(globalWorkspace);
    expect(seenContext?.roots).toBe(parentContext.roots);
    expect(seenContext?.overlayByRoot).toBe(overlayByRoot);
    expect(seenContext?.projectId).toBe(99);
    expect(seenContext?.projectIndexed).toBe(true);
    expect(seenContext?.runtimeEnv).toBe(runtimeEnv);
    expect(seenContext?.ports).toBe(ports);
    expect(seenContext?.sessionId).toBe(1234);
  });
});
