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
const {
  kimiCodeSeedUpsertModels,
  mapKimiCodeModels,
} = await import('@mcp/services/services/kimi-code.js');
const { consumeStream } = await import('../../core/runner/nodes/executing-stream.js');
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

  it('expands scalar property shorthands into Moonshot-compatible schema objects', () => {
    const result = toKimiToolParam({
      name: 'dynamic_tool',
      parameters: {
        type: 'object',
        properties: {
          type: 'string',
          enabled: 'boolean',
          unrestricted: true,
        },
      },
    });

    const fn = result.function as { parameters: { properties: Record<string, unknown> } };
    expect(fn.parameters.properties).toEqual({
      type: { type: 'string' },
      enabled: { type: 'boolean' },
      unrestricted: {},
    });
  });

  it('normalizes scalar shorthands recursively inside nested object properties', () => {
    const result = toKimiToolParam({
      name: 'nested_tool',
      parameters: {
        type: 'object',
        properties: {
          options: {
            properties: {
              type: 'string',
            },
          },
        },
      },
    });

    const fn = result.function as {
      parameters: {
        properties: { options: { type: string; properties: Record<string, unknown> } };
      };
    };
    expect(fn.parameters.properties.options).toEqual({
      type: 'object',
      properties: { type: { type: 'string' } },
    });
  });

  it('collapses root anyOf while retaining the object contract for Unity MCP schemas', () => {
    const result = toKimiToolParam({
      name: 'ext_unity__add_component',
      parameters: {
        type: 'object',
        properties: {
          instanceId: { type: 'integer' },
          target: { type: 'object' },
          componentType: { type: 'string' },
        },
        required: ['componentType'],
        anyOf: [
          { required: ['instanceId'] },
          { required: ['target'] },
        ],
      },
    });

    const fn = result.function as {
      parameters: {
        type: string;
        required: string[];
        anyOf?: unknown;
      };
    };
    expect(fn.parameters.type).toBe('object');
    expect(fn.parameters.required).toEqual(['componentType']);
    expect(fn.parameters.anyOf).toBeUndefined();
  });

  it('merges properties declared only inside root anyOf branches', () => {
    const result = toKimiToolParam({
      name: 'union_tool',
      parameters: {
        anyOf: [
          {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
          {
            type: 'object',
            properties: { instanceId: { type: 'integer' } },
            required: ['instanceId'],
          },
        ],
      },
    });

    const fn = result.function as {
      parameters: {
        type: string;
        properties: Record<string, unknown>;
        anyOf?: unknown;
      };
    };
    expect(fn.parameters).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string' },
        instanceId: { type: 'integer' },
      },
    });
  });

  it('normalizes nested type plus anyOf without adding a conflicting branch type', () => {
    const result = toKimiToolParam({
      name: 'nested_union_tool',
      parameters: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            anyOf: [
              { maxLength: 10 },
              { type: 'number' },
            ],
          },
        },
      },
    });

    const fn = result.function as {
      parameters: {
        properties: {
          value: { type?: string; anyOf: Array<Record<string, unknown>> };
        };
      };
    };
    expect(fn.parameters.properties.value).toEqual({
      anyOf: [
        { maxLength: 10, type: 'string' },
        { type: 'number' },
      ],
    });
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

  it('treats iterator EOF without finish_reason as a truncated provider attempt', async () => {
    mockCreate.mockResolvedValueOnce(
      (async function* () {
        yield {
          choices: [{ delta: { content: 'partial' }, finish_reason: null }],
        };
      })(),
    );

    const provider = new KimiCodeChatProvider({ apiKey: 'test' });

    await expect(consumeStream({
      stream: provider.chat({
        system: 'sys',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        tools: [],
      }),
    })).rejects.toMatchObject({
      name: 'ProviderStreamProtocolError',
      status: 502,
      code: 'stream_ended_no_result',
    });
  });
});

describe('KimiCodeChatProvider.chat() — K3 reasoning effort', () => {
  function completedStream(): AsyncIterable<unknown> {
    return (async function* () {
      yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
    })();
  }

  async function run(
    model: string,
    reasoningEffort?: string,
    temperature?: number,
  ): Promise<Record<string, unknown>> {
    mockCreate.mockResolvedValueOnce(completedStream());
    const provider = new KimiCodeChatProvider({ apiKey: 'test', model });
    for await (const _delta of provider.chat({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [],
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(typeof temperature === 'number' ? { inference: { temperature } } : {}),
    })) {
      // Drain the stream so the provider request completes.
    }
    const calls = mockCreate.mock.calls;
    return calls[calls.length - 1][0] as Record<string, unknown>;
  }

  it('forwards the selected level as reasoning_effort for K3', async () => {
    const body = await run('k3', 'max');
    expect(body.reasoning_effort).toBe('max');
  });

  it('leaves K3 reasoning_effort unset when the session uses the model default', async () => {
    const body = await run('k3');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('does not send reasoning_effort to older Kimi models', async () => {
    const body = await run('kimi-k2.6', 'high');
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('forces K3 temperature to 1 despite a user override', async () => {
    const body = await run('k3', undefined, 0.2);
    expect(body.temperature).toBe(1);
  });

  it('sends K3 temperature 1 even without a user override', async () => {
    const body = await run('k3');
    expect(body.temperature).toBe(1);
  });

  it('keeps user temperature behavior for non-K3 models', async () => {
    const body = await run('kimi-for-coding', undefined, 0.2);
    expect(body.temperature).toBe(0.2);
  });
});

describe('Kimi Code K3 model metadata', () => {
  it('maps live K3 discovery to its discrete reasoning levels', () => {
    const [model] = mapKimiCodeModels([{ id: 'k3' }]);

    expect(model).toMatchObject({
      model_id: 'k3',
      can_reason: true,
      context_window: 1_048_576,
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'high', 'max'],
    });
  });

  it('keeps K3 available with the same capability when live discovery falls back', () => {
    const model = kimiCodeSeedUpsertModels().find((candidate) => candidate.model_id === 'k3');

    expect(model).toMatchObject({
      default_reasoning_level: 'high',
      supported_reasoning_levels: ['low', 'high', 'max'],
    });
  });

  it('does not change the established K2 reasoning levels', () => {
    const [model] = mapKimiCodeModels([{ id: 'kimi-k2.6' }]);

    expect(model.supported_reasoning_levels).toEqual(['low', 'medium', 'high']);
    expect(model.default_reasoning_level).toBe('high');
  });

  it('keeps the current coding aliases on a boolean thinking control', () => {
    const [model] = mapKimiCodeModels([{ id: 'kimi-for-coding' }]);

    expect(model).toMatchObject({
      context_window: 262_144,
      can_reason: true,
      supported_reasoning_levels: null,
      default_reasoning_level: null,
      input_modalities: ['text', 'image', 'video'],
    });
  });

  it('marks k3-256k as image-only and keeps the K3 effort levels', () => {
    const [model] = mapKimiCodeModels([{ id: 'k3-256k' }]);

    expect(model).toMatchObject({
      context_window: 262_144,
      supported_reasoning_levels: ['low', 'high', 'max'],
      default_reasoning_level: 'high',
      input_modalities: ['text', 'image'],
    });
  });
});
