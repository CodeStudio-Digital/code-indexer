/**
 * Active hybrid pre-read behavior: historical reads never become hard
 * refusals, while mutation-aware rereads and context-visibility checks remain.
 */
import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ToolResultBlock } from "@mcp/provider-sdk";

/**
 * Mock read tool that always succeeds with a tagged body. Counts dispatches
 * so we can prove the pre-read guard prevented downstream calls.
 */
function makeReadTool(name: string): { tool: CoderTool; dispatchCount: () => number } {
  let count = 0;
  const tool: CoderTool = {
    name,
    description: 'mock read',
    source: 'native',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: async (_args, _ctx) => {
      count++;
      return { content: 'mock content for ' + name, isError: false };
    },
  };
  return { tool, dispatchCount: () => count };
}

function makeRunner(provider: ChatProvider, registry: ToolRegistry, agentLoopV2 = true): CoderRunner {
  return new CoderRunner({
    provider,
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    agentLoopV2,
    maxTurns: 10,
  });
}

describe('hybrid mutation-aware rereads', () => {
  function getMessages(runner: CoderRunner): AgentMessage[] {
    return (runner as unknown as { messages: AgentMessage[] }).messages;
  }
  function findToolResult(runner: CoderRunner, useId: string): ToolResultBlock | undefined {
    for (const m of getMessages(runner)) {
      if (m.role !== 'tool') continue;
      for (const b of m.content) {
        if (b.type === 'tool_result' && b.tool_use_id === useId) return b as ToolResultBlock;
      }
    }
    return undefined;
  }

  it('allows re-read when the prior tool_result has been elided from context', async () => {
    let runnerRef: CoderRunner | null = null;
    let callCount = 0;
    const provider: ChatProvider = {
      name: 'p', model: 'm-1',
      setModel(m: string) { this.model = m; },
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        callCount++;
        // Before the second tool-emitting turn fires, elide the FIRST
        // tool_result the way a compaction marker would.
        if (callCount === 2 && runnerRef) {
          for (const m of getMessages(runnerRef)) {
            if (m.role !== 'tool') continue;
            m.content = m.content.map((b) =>
              b.type === 'tool_result'
                ? { ...b, content: '[duplicate-read elided] Superseded — original dropped.' }
                : b,
            );
          }
        }
        if (callCount > 3) {
          yield { type: 'text_delta', text: 'done' };
          yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
          yield { type: 'done' };
          return;
        }
        const id = `tu_${callCount}`;
        yield { type: 'tool_call_start', id, name: 'mcp__read_file' };
        yield {
          type: 'tool_call_end',
          id,
          name: 'mcp__read_file',
          input: { file_path: 'src/foo.ts', start_line: 1, end_line: 50 },
        };
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      },
    };
    const { tool, dispatchCount } = makeReadTool('mcp__read_file');
    const registry = new ToolRegistry();
    registry.register(tool);
    runnerRef = makeRunner(provider, registry);
    await runnerRef.run();
    // Both reads dispatch: the second is allowed because the first was elided.
    expect(dispatchCount()).toBeGreaterThanOrEqual(2);
  });

  it('allows re-read after edit_file and replaces the content with a unified diff', async () => {
    let callCount = 0;
    const provider: ChatProvider = {
      name: 'p', model: 'm-1',
      setModel(m: string) { this.model = m; },
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call_start', id: 'r1', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r1',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts', start_line: 1, end_line: 5 },
          };
        } else if (callCount === 2) {
          yield { type: 'tool_call_start', id: 'e1', name: 'edit_file' };
          yield {
            type: 'tool_call_end',
            id: 'e1',
            name: 'edit_file',
            input: { path: 'src/foo.ts', old_string: 'line 2', new_string: 'LINE 2 CHANGED' },
          };
        } else if (callCount === 3) {
          yield { type: 'tool_call_start', id: 'r2', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r2',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts', start_line: 1, end_line: 5 },
          };
        } else {
          yield { type: 'text_delta', text: 'done' };
        }
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      },
    };
    let readCallNum = 0;
    const readContents = [
      'line 1\nline 2\nline 3\nline 4\nline 5',
      'line 1\nLINE 2 CHANGED\nline 3\nline 4\nline 5',
    ];
    const readTool: CoderTool = {
      name: 'mcp__read_file',
      description: 'r',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: readContents[readCallNum++] ?? 'fallback', isError: false }),
    };
    const editTool: CoderTool = {
      name: 'edit_file',
      description: 'e',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'Edited src/foo.ts (1 replacement)', isError: false }),
    };
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(editTool);
    const runner = makeRunner(provider, registry);
    await runner.run();
    expect(readCallNum).toBe(2);
    const r2 = findToolResult(runner, 'r2');
    expect(r2).toBeDefined();
    expect(r2!.content).toMatch(/\[reread-after-edit\]/);
    expect(r2!.content).toMatch(/@@/); // unified-diff hunk header
    expect(r2!.content).toMatch(/LINE 2 CHANGED/);
    // is_error should be false — this is a successful re-read, just shaped.
    expect(r2!.is_error).not.toBe(true);
  });

  it('mutation has priority over elide (returns [reread-after-edit] header even when prior is elided)', async () => {
    let runnerRef: CoderRunner | null = null;
    let callCount = 0;
    const provider: ChatProvider = {
      name: 'p', model: 'm-1',
      setModel(m: string) { this.model = m; },
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        callCount++;
        if (callCount === 1) {
          yield { type: 'tool_call_start', id: 'r1', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r1',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts' },
          };
        } else if (callCount === 2) {
          yield { type: 'tool_call_start', id: 'e1', name: 'edit_file' };
          yield {
            type: 'tool_call_end',
            id: 'e1',
            name: 'edit_file',
            input: { path: 'src/foo.ts', old_string: 'x', new_string: 'y' },
          };
        } else if (callCount === 3) {
          if (runnerRef) {
            for (const m of getMessages(runnerRef)) {
              if (m.role !== 'tool') continue;
              m.content = m.content.map((b) =>
                b.type === 'tool_result' && b.tool_use_id === 'r1'
                  ? { ...b, content: '[duplicate-read elided] dropped' }
                  : b,
              );
            }
          }
          yield { type: 'tool_call_start', id: 'r2', name: 'mcp__read_file' };
          yield {
            type: 'tool_call_end',
            id: 'r2',
            name: 'mcp__read_file',
            input: { file_path: 'src/foo.ts' },
          };
        } else {
          yield { type: 'text_delta', text: 'done' };
        }
        yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
        yield { type: 'done' };
      },
    };
    const readTool: CoderTool = {
      name: 'mcp__read_file',
      description: 'r',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'current file content', isError: false }),
    };
    const editTool: CoderTool = {
      name: 'edit_file',
      description: 'e',
      source: 'native',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: async () => ({ content: 'Edited', isError: false }),
    };
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(editTool);
    runnerRef = makeRunner(provider, registry);
    await runnerRef.run();
    const r2 = findToolResult(runnerRef, 'r2');
    expect(r2).toBeDefined();
    // Mutation wins over elide: gets the reread-after-edit header (with the
    // compacted-fallback message because the prior result is no longer in
    // context, but NOT the bare "[duplicate-read elided]" path).
    expect(r2!.content).toMatch(/\[reread-after-edit\]/);
  });
});
