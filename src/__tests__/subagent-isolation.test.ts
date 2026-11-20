/**
 * PR-6 (Rows 23 + 24) — subagent isolation.
 *
 * Row 24: the session-scoped completion hook is suppressed when
 * isSubagent=true so a parallel spawn_agents run doesn't spam the parent's
 * hook listeners with N×completion fires per subagent.
 *
 * Row 23: subagent system prompts get the short v2 framing block
 * (persistence + don't re-read) appended when the parent runs with v2.
 */
import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from "@mcp/provider-sdk";
import { buildSubagentLoopFraming } from '@mcp/code-agent/core/system-prompt.js';

class TextOnlyProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'ok' };
    yield { type: 'usage', usage: { input_tokens: 5, output_tokens: 1 } };
    yield { type: 'done' };
  }
}

interface FakeHookRegistry {
  fireCompletion: (...args: unknown[]) => Promise<void>;
  hasHandlers: boolean;
  completionFires: number;
}

function makeHookRegistry(): FakeHookRegistry {
  const reg: FakeHookRegistry = {
    completionFires: 0,
    hasHandlers: true,
    async fireCompletion() { reg.completionFires++; },
  };
  return reg;
}

function makeRunner(provider: ChatProvider, isSubagent: boolean, hookRegistry: FakeHookRegistry): CoderRunner {
  return new CoderRunner({
    provider,
    registry: new ToolRegistry(),
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    isSubagent,
    // The runner type accepts a registry-like object via duck typing; we
    // cast through unknown to satisfy the more specific type.
    hookRegistry: hookRegistry as unknown as ConstructorParameters<typeof CoderRunner>[0]['hookRegistry'],
  });
}

describe('PR-6 R24 — session-scoped hooks suppressed for subagents', () => {
  it('parent runner FIRES fireCompletion on a clean text-only run', async () => {
    const reg = makeHookRegistry();
    const runner = makeRunner(new TextOnlyProvider(), /* isSubagent */ false, reg);
    await runner.run();
    expect(reg.completionFires).toBe(1);
  });

  it('subagent runner SKIPS fireCompletion (isSubagent=true gate)', async () => {
    const reg = makeHookRegistry();
    const runner = makeRunner(new TextOnlyProvider(), /* isSubagent */ true, reg);
    await runner.run();
    expect(reg.completionFires).toBe(0);
  });
});

describe('PR-6 R23 — buildSubagentLoopFraming exports a discipline block', () => {
  it('contains persistence framing without the active-context pointer', () => {
    const block = buildSubagentLoopFraming();
    expect(block).toContain('# Subagent contract');
    expect(block).toContain('implement and verify the assigned change');
    expect(block).toContain('Reuse evidence');
    // Active context is NOT mentioned — subagents don't get that injection.
    expect(block).not.toContain('<active-context>');
    expect(block).not.toContain('# Active context');
  });

  it('bounds delegation and preserves the investigation scope', () => {
    const block = buildSubagentLoopFraming();
    expect(block).toContain('investigate without edits');
    expect(block).toContain('Do not spawn children');
  });

  it('directs recovery through supported tool discovery', () => {
    const block = buildSubagentLoopFraming();
    expect(block).toContain('Discover tools by schema, never guess names');
  });
});

describe('PR-6 R23 — agentLoopV2 propagation type contract', () => {
  it('SubagentParent accepts agentLoopV2 (compile-time check)', () => {
    type RunSubagent = typeof import('@mcp/code-agent/tools/implement-subagent.js')['runSubagent'];
    // Type-check only — we never invoke this.
    void (async () => {
      const parent: Parameters<RunSubagent>[0] = {
        provider: new TextOnlyProvider(),
        tools: [],
        ctx: { cwd: '/tmp', projectName: 'test' },
        agentLoopV2: true,
      };
      void parent;
    });
    expect(true).toBe(true);
  });
});

describe('PR-6 — parent runner exposes agentLoopV2 to factories', () => {
  it('runner.agentLoopV2 is true when constructed with v2', () => {
    const runner = new CoderRunner({
      provider: new TextOnlyProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      toolContext: { cwd: '/tmp', projectName: 'test' },
      agentLoopV2: true,
    });
    expect(runner.agentLoopV2).toBe(true);
  });

  it('runner.agentLoopV2 is false by default', () => {
    const runner = new CoderRunner({
      provider: new TextOnlyProvider(),
      registry: new ToolRegistry(),
      systemPrompt: 'sys',
      toolContext: { cwd: '/tmp', projectName: 'test' },
    });
    expect(runner.agentLoopV2).toBe(false);
  });
});
