/**
 * PR-6 (Rows 23 + 24) — subagent isolation.
 *
 * Row 24: session-scoped hooks (completion / fallback / error) are
 * suppressed when isSubagent=true so a parallel spawn_agents run doesn't
 * spam the parent's hook listeners with N×completion fires per subagent.
 * Tool-scoped hooks (fireToolCall) keep working — they enforce policy
 * that should apply uniformly across the whole runner tree.
 *
 * Row 23: subagent system prompts get the short v2 framing block
 * (persistence + don't re-read) appended when the parent runs with v2.
 */
import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';
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
  fireFallback: (...args: unknown[]) => Promise<void>;
  fireError: (...args: unknown[]) => Promise<void>;
  fireToolCall: (...args: unknown[]) => Promise<void>;
  hasHandlers: boolean;
  completionFires: number;
  fallbackFires: number;
  errorFires: number;
  toolCallFires: number;
}

function makeHookRegistry(): FakeHookRegistry {
  const reg: FakeHookRegistry = {
    completionFires: 0,
    fallbackFires: 0,
    errorFires: 0,
    toolCallFires: 0,
    hasHandlers: true,
    async fireCompletion() { reg.completionFires++; },
    async fireFallback() { reg.fallbackFires++; },
    async fireError() { reg.errorFires++; },
    async fireToolCall() { reg.toolCallFires++; },
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
    // Sanity: the run still completed cleanly even though the hook didn't fire.
    expect(reg.errorFires).toBe(0);
  });
});

describe('PR-6 R23 — buildSubagentLoopFraming exports a discipline block', () => {
  it('contains persistence framing without the active-context pointer', () => {
    const block = buildSubagentLoopFraming();
    expect(block).toContain('# Agent loop (subagent)');
    expect(block).toContain('carry it through end-to-end');
    expect(block).toContain('# Do not re-read what you already have');
    // Active context is NOT mentioned — subagents don't get that injection.
    expect(block).not.toContain('<active-context>');
    expect(block).not.toContain('# Active context');
  });

  it('warns specifically about slice-resolver snap behaviour (PR-5 alignment)', () => {
    const block = buildSubagentLoopFraming();
    expect(block).toContain('Reads snap to the enclosing symbol');
    expect(block).toContain('around_line');
  });

  it('mentions the runner-level refusal contract', () => {
    const block = buildSubagentLoopFraming();
    expect(block).toContain('refuses identical-content tool results');
  });
});

describe('PR-6 R23 — agentLoopV2 propagation type contract', () => {
  it('SubagentParent accepts agentLoopV2 (compile-time check)', async () => {
    const { runSubagent } = await import('@mcp/code-agent/tools/implement-subagent.js');
    // Type-check only — we never invoke this.
    void (async () => {
      void runSubagent;
      const parent: Parameters<typeof runSubagent>[0] = {
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
