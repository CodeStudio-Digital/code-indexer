/**
 * Tests for the Kimi-Code provider — focus on the two bugs the Fase E
 * plan fixed:
 *
 *   H2 — Kimi-for-Coding rejects assistant `content: ""` / whitespace-only
 *        when `tool_calls` is also present (HTTP 400 "text content is empty").
 *        Confirmed by reading kosong's own `_convert_message`:
 *        `.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:307-341`.
 *        Fix: omit `content` entirely in that case.
 *
 *   H6 — Empty `tool_call` deltas (no id, name, arguments) were creating
 *        ghost entries in `toolAcc`, causing tool_call_end with name="".
 *        Mirrored from kosong's `skip empty tool calls`
 *        (`kimi.py:479-481`).
 *
 * The unit tests cover the pure helpers (`isEffectivelyEmptyText`,
 * `toKimiMessages`) directly and exercise `chat()` against a mocked
 * OpenAI client to confirm the H6 guard.
 */
import { describe, expect, it, vi } from 'vitest';

// vi.mock is hoisted above all imports — declare mockCreate via vi.hoisted
// so the factory below can reference it without temporal-dead-zone errors.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const {
  KimiCodeChatProvider,
  isEffectivelyEmptyText,
  toKimiMessages,
  toKimiToolParam,
} = await import('../kimi-code.js');
import type { AgentMessage, ChatDelta } from '../../core/messages.js';

describe('isEffectivelyEmptyText', () => {
  it('returns true for empty and whitespace-only strings', () => {
    expect(isEffectivelyEmptyText('')).toBe(true);
    expect(isEffectivelyEmptyText(' ')).toBe(true);
    expect(isEffectivelyEmptyText('\n')).toBe(true);
    expect(isEffectivelyEmptyText('\t\n  ')).toBe(true);
  });

  it('returns false for any non-whitespace character', () => {
    expect(isEffectivelyEmptyText('x')).toBe(false);
    expect(isEffectivelyEmptyText(' x ')).toBe(false);
    expect(isEffectivelyEmptyText('hello')).toBe(false);
  });
});

describe('toKimiMessages — H2 assistant.content with tool_calls', () => {
  const userTurn: AgentMessage = {
    role: 'user',
    content: [{ type: 'text', text: 'do it' }],
  };

  function assistantWith(text: string, withTool: boolean): AgentMessage {
    return {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...(withTool
          ? [{ type: 'tool_use' as const, id: 'c1', name: 'read_file', input: { path: 'x' } }]
          : []),
      ],
    };
  }

  it('omits content when text is empty AND tool_calls is present', () => {
    const out = toKimiMessages('sys', [userTurn, assistantWith('', true)]);
    const assistant = out[2] as { role: string; content?: unknown; tool_calls?: unknown };
    expect(assistant.role).toBe('assistant');
    expect(assistant.content).toBeUndefined();
    expect(assistant.tool_calls).toBeDefined();
  });

  it('omits content when text is whitespace-only AND tool_calls is present', () => {
    const out = toKimiMessages('sys', [userTurn, assistantWith('   \n\t', true)]);
    const assistant = out[2] as { role: string; content?: unknown; tool_calls?: unknown };
    expect(assistant.content).toBeUndefined();
    expect(assistant.tool_calls).toBeDefined();
  });

  it('keeps content when text is non-empty WITH tool_calls', () => {
    const out = toKimiMessages('sys', [userTurn, assistantWith('I will read it', true)]);
    const assistant = out[2] as { role: string; content?: unknown };
    expect(assistant.content).toBe('I will read it');
  });

  it('keeps content === "" when no tool_calls (retrocompat for non-Kimi paths)', () => {
    const out = toKimiMessages('sys', [userTurn, assistantWith('', false)]);
    const assistant = out[2] as { role: string; content?: unknown };
    expect(assistant.content).toBe('');
  });
});

describe('toKimiToolParam — M6 builtin functions (prefix $)', () => {
  it('emits builtin_function shape for tools whose name starts with $', () => {
    const result = toKimiToolParam({
      name: '$web_search',
      description: 'should be omitted',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
    });
    expect(result).toEqual({
      type: 'builtin_function',
      function: { name: '$web_search' },
    });
    // description and parameters must NOT leak — Kimi server already has them.
    expect((result.function as Record<string, unknown>).description).toBeUndefined();
    expect((result.function as Record<string, unknown>).parameters).toBeUndefined();
  });

  it('emits normal function shape for non-$ tools', () => {
    const result = toKimiToolParam({
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    });
    expect(result.type).toBe('function');
    const fn = result.function as Record<string, unknown>;
    expect(fn.name).toBe('read_file');
    expect(fn.description).toBe('Read a file');
    expect(fn.parameters).toBeDefined();
  });

  it('does not treat names containing $ in the middle as builtin', () => {
    const result = toKimiToolParam({ name: 'foo$bar', description: 'x' });
    expect(result.type).toBe('function');
  });
});

describe('KimiCodeChatProvider.chat() — H6 skip empty tool_call deltas', () => {
  function makeChunk(toolCalls: Array<Record<string, unknown>> | undefined): unknown {
    return {
      choices: [{ delta: toolCalls ? { tool_calls: toolCalls } : {}, finish_reason: null }],
    };
  }
  function makeFinish(): unknown {
    return { choices: [{ delta: {}, finish_reason: 'tool_calls' }] };
  }

  it('does not emit tool_call_end for chunks that carry only an empty tc entry', async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        // Empty heartbeat chunk: no id, no name, no args. Pre-fix this
        // would create a ghost entry with name="" in toolAcc.
        yield makeChunk([{ index: 0, function: {} }]);
        // Real tool_call follows; should produce exactly one tool_call_end.
        yield makeChunk([{ index: 0, id: 'c1', function: { name: 'read_file' } }]);
        yield makeChunk([{ index: 0, function: { arguments: '{"path":"a"}' } }]);
        yield makeFinish();
      })(),
    );

    const provider = new KimiCodeChatProvider({ apiKey: 'test' });
    const deltas: ChatDelta[] = [];
    for await (const d of provider.chat({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
    })) {
      deltas.push(d);
    }

    const ends = deltas.filter((d): d is Extract<ChatDelta, { type: 'tool_call_end' }> =>
      d.type === 'tool_call_end',
    );
    expect(ends).toHaveLength(1);
    expect(ends[0].name).toBe('read_file');
    expect(ends[0].name).not.toBe('');
    expect(ends[0].input).toEqual({ path: 'a' });
  });

  it('skips a wholly-empty tc entry without ever creating an accumulator slot', async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        // Two consecutive empty chunks — both must be skipped.
        yield makeChunk([{ index: 0 }]);
        yield makeChunk([{ index: 0, function: {} }]);
        yield makeFinish();
      })(),
    );

    const provider = new KimiCodeChatProvider({ apiKey: 'test' });
    const deltas: ChatDelta[] = [];
    for await (const d of provider.chat({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
    })) {
      deltas.push(d);
    }

    const ends = deltas.filter((d) => d.type === 'tool_call_end');
    expect(ends).toHaveLength(0);
  });
});
