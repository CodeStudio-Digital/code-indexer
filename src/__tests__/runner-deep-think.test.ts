import { describe, it, expect } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta } from '@mcp/code-agent/core/messages.js';

/**
 * Captures requests + serves a one-shot text response. Lets each test
 * inspect the messages array as it was sent to the main model.
 */
class CapturingProvider implements ChatProvider {
  readonly name: string;
  model: string;
  setModel(m: string) { this.model = m; }
  captured: ChatRequest[] = [];
  text: string;

  constructor(name = 'main', model = 'main-1', text = 'ok') {
    this.name = name;
    this.model = model;
    this.text = text;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    this.captured.push(req);
    yield { type: 'text_delta', text: this.text };
    yield { type: 'usage', usage: { input_tokens: 10, output_tokens: 2 } };
    yield { type: 'done' };
  }
}

class FailingProvider implements ChatProvider {
  readonly name = 'aux-fail';
  model = 'aux-1';
  setModel(m: string) { this.model = m; }
  // eslint-disable-next-line require-yield
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    throw new Error('boom');
  }
}

function makeRunner(
  main: ChatProvider,
  opts: {
    deepThink?: boolean;
    deepThinkModel?: string;
    aux?: ChatProvider;
    persistPreThoughts?: boolean;
    preThinkMinInputTokens?: number;
    userText?: string;
  } = {},
): CoderRunner {
  const registry = new ToolRegistry();
  return new CoderRunner({
    provider: main,
    registry,
    systemPrompt: 'sys',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    initialMessages: [{ role: 'user', content: [{ type: 'text', text: opts.userText ?? 'please help' }] }],
    deepThink: opts.deepThink,
    deepThinkModel: opts.deepThinkModel,
    persistPreThoughts: opts.persistPreThoughts,
    preThinkMinInputTokens: opts.preThinkMinInputTokens,
    createProvider: opts.aux
      ? async (_name: string, _model: string) => opts.aux!
      : undefined,
  });
}

function hasPreThoughtBlock(messages: AgentMessage[]): boolean {
  return messages.some((m) =>
    m.role === 'assistant'
    && m.content.length === 1
    && m.content[0].type === 'text'
    && (m.content[0] as { text: string }).text.startsWith('<thinking data-source="aux"'),
  );
}

describe('CoderRunner — deepThink off (baseline)', () => {
  it('does not call the auxiliary and does not inject any <thinking data-source="aux"> block', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'should not be called');
    const r = makeRunner(main, { deepThink: false, aux });
    await r.run();
    expect(main.captured).toHaveLength(1);
    expect(aux.captured).toHaveLength(0);
    expect(hasPreThoughtBlock(main.captured[0].messages)).toBe(false);
  });
});

describe('CoderRunner — deepThink on', () => {
  it('calls the auxiliary before the main provider and prefills a <thinking> block', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'I should call the read tool first.');
    const events: Array<{ name: string; payload: unknown }> = [];
    const r = makeRunner(main, {
      deepThink: true,
      deepThinkModel: 'haiku',
      aux,
    });
    r.on('pre_think_started', (p) => events.push({ name: 'pre_think_started', payload: p }));
    r.on('pre_think_delta', (p) => events.push({ name: 'pre_think_delta', payload: p }));
    r.on('pre_think_completed', (p) => events.push({ name: 'pre_think_completed', payload: p }));

    await r.run();

    expect(aux.captured).toHaveLength(1);
    expect(main.captured).toHaveLength(1);

    const sentToMain = main.captured[0].messages;
    expect(hasPreThoughtBlock(sentToMain)).toBe(true);
    const preThoughtMsg = sentToMain[sentToMain.length - 1];
    const text = (preThoughtMsg.content[0] as { text: string }).text;
    expect(text).toContain('<thinking data-source="aux"');
    expect(text).toContain('I should call the read tool first.');
    expect(text).toContain('</thinking>');

    const names = events.map((e) => e.name);
    expect(names).toContain('pre_think_started');
    expect(names).toContain('pre_think_delta');
    expect(names).toContain('pre_think_completed');

    // Defense-in-depth: the prefill block delivered to the main model must
    // be PURE text — no tool_use, no tool_result, nothing that would make
    // the main provider serialize a half-formed tool call back into the
    // session history.
    expect(preThoughtMsg.role).toBe('assistant');
    expect(preThoughtMsg.content).toHaveLength(1);
    expect(preThoughtMsg.content[0].type).toBe('text');
    const blockTypes = sentToMain.flatMap((m) => m.content.map((b) => b.type));
    expect(blockTypes).not.toContain('tool_use');
  });

  it('passes the auxiliary an empty tool list (auxiliary never executes tools)', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'reason about it');
    const r = makeRunner(main, { deepThink: true, aux });
    await r.run();
    expect(aux.captured[0].tools).toEqual([]);
  });
});

describe('CoderRunner — deepThink with billed-but-empty auxiliary', () => {
  // Reasoning models (gpt-5 reasoning='high', o3, etc.) can consume the
  // whole output budget on reasoning_tokens and return text=''. Without
  // the empty-marker path the operator just sees nothing — silent
  // degradation hides the fact that they're paying for an aux turn that
  // contributes zero signal to the main model. This test pins the
  // contract that empty-but-billed turns get persisted with a flag.
  it('persists an empty marker block when aux returns text="" but usage>0', async () => {
    const main = new CapturingProvider();
    class BilledEmptyAux implements ChatProvider {
      readonly name = 'aux-empty';
      model = 'reasoning-1';
      setModel(m: string) { this.model = m; }
      async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
        // No text_delta at all — only a usage event with non-zero tokens.
        yield { type: 'usage', usage: { input_tokens: 100, output_tokens: 0 } };
        yield { type: 'done' };
      }
    }
    const aux = new BilledEmptyAux();
    const r = makeRunner(main, { deepThink: true, aux });
    await r.run();

    // The empty marker should appear in this.messages (persisted history)
    // but NOT in the prefill that goes to the main model — empty body adds
    // zero signal and would just cost input tokens.
    const persistedTexts = (r.messages as AgentMessage[]).flatMap((m) =>
      m.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text),
    );
    const hasEmptyMarker = persistedTexts.some((t) => t.includes('data-empty="true"'));
    expect(hasEmptyMarker).toBe(true);

    const sentToMain = main.captured[0].messages;
    expect(hasPreThoughtBlock(sentToMain)).toBe(false);
  });
});

describe('CoderRunner — deepThink idle-close (provider forgets `done`)', () => {
  // Codex/ChatGPT (and some adapters) occasionally finish streaming text
  // and then hold the connection open indefinitely without emitting `done`.
  // Without an idle watchdog the for-await wedges until the hard timeout
  // marks the turn as failed and DISCARDS the text we already have.
  //
  // This test pins the new behaviour: text arrives, no `done`, after a
  // short idle window the helper closes gracefully and the prefill block
  // IS produced (not lost as a timeout).
  it('closes gracefully and persists text when stream stalls after last delta', async () => {
    const main = new CapturingProvider();
    class IdleAfterTextAux implements ChatProvider {
      readonly name = 'aux-idle';
      model = 'idle-1';
      setModel(m: string) { this.model = m; }
      async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
        yield { type: 'text_delta', text: 'consider tool A first' };
        yield { type: 'usage', usage: { input_tokens: 50, output_tokens: 5 } };
        // Intentionally hang — no `done`, no further deltas. The helper
        // should detect idle and abort us via the AbortController. We
        // cooperate with the signal (real providers do this via fetch's
        // built-in abort handling) so the test can complete in <5s.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    }
    const aux = new IdleAfterTextAux();
    const r = makeRunner(main, { deepThink: true, aux });
    let completedPayload: { text?: string } | null = null;
    let failedPayload: { error?: string } | null = null;
    r.on('pre_think_completed', (p) => { completedPayload = p as { text?: string }; });
    r.on('pre_think_failed', (p) => { failedPayload = p as { error?: string }; });

    await r.run();

    // Should have completed (not failed), with the text we received.
    expect(failedPayload).toBeNull();
    expect(completedPayload).not.toBeNull();
    expect(completedPayload!.text).toBe('consider tool A first');

    // Main model must have received the prefill block.
    expect(hasPreThoughtBlock(main.captured[0].messages)).toBe(true);
  }, 10_000);
});

describe('CoderRunner — deepThink degrades when auxiliary fails', () => {
  it('emits pre_think_failed and still calls the main provider without the prefill', async () => {
    const main = new CapturingProvider();
    const aux = new FailingProvider();
    const r = makeRunner(main, { deepThink: true, aux });
    let failedPayload: { error: string } | null = null;
    r.on('pre_think_failed', (p) => { failedPayload = p as { error: string }; });

    await r.run();

    expect(main.captured).toHaveLength(1);
    expect(hasPreThoughtBlock(main.captured[0].messages)).toBe(false);
    expect(failedPayload).not.toBeNull();
    expect(failedPayload!.error).toMatch(/boom/);
  });
});

describe('CoderRunner — deepThink heuristic gate (preThinkMinInputTokens)', () => {
  it('skips the auxiliary when the user message is shorter than the threshold', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'should not be called');
    const r = makeRunner(main, {
      deepThink: true,
      aux,
      preThinkMinInputTokens: 50,
      userText: 'ok',
    });
    await r.run();
    expect(aux.captured).toHaveLength(0);
    expect(hasPreThoughtBlock(main.captured[0].messages)).toBe(false);
  });

  it('still calls the auxiliary when the user message exceeds the threshold', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'plan: a, b, c');
    const longText = 'I need a careful refactor of the authentication module: '
      + 'extract the token-validation helper, write unit tests for it, '
      + 'and update the integration tests so they still pass.';
    const r = makeRunner(main, {
      deepThink: true,
      aux,
      preThinkMinInputTokens: 10,
      userText: longText,
    });
    await r.run();
    expect(aux.captured).toHaveLength(1);
    expect(hasPreThoughtBlock(main.captured[0].messages)).toBe(true);
  });
});

describe('CoderRunner — deepThink persistence', () => {
  it('appends the pre-thought to this.messages by default (persistPreThoughts: true)', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'persisted thought');
    const r = makeRunner(main, { deepThink: true, aux });
    await r.run();
    expect(hasPreThoughtBlock(r.messages as AgentMessage[])).toBe(true);
  });

  it('does NOT persist when persistPreThoughts is false', async () => {
    const main = new CapturingProvider();
    const aux = new CapturingProvider('aux', 'haiku', 'ephemeral thought');
    const r = makeRunner(main, {
      deepThink: true,
      aux,
      persistPreThoughts: false,
    });
    await r.run();
    expect(hasPreThoughtBlock(r.messages as AgentMessage[])).toBe(false);
    // still sent to the main model this turn
    expect(hasPreThoughtBlock(main.captured[0].messages)).toBe(true);
  });
});
