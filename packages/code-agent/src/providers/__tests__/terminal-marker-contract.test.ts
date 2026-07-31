import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  geminiGenerate: vi.fn(),
  cloudCodeStream: vi.fn(),
  bedrockSend: vi.fn(),
}));

vi.mock('@google/genai', () => ({
  ThinkingLevel: {
    MINIMAL: 'MINIMAL',
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
  },
  GoogleGenAI: class FakeGoogleGenAI {
    models = { generateContentStream: mocks.geminiGenerate };
  },
}));

vi.mock('@mcp/services/services/cloudcode.js', () => ({
  DEFAULT_THINKING_MODE: -1,
  createAuthClient: vi.fn(() => ({})),
  streamGenerateContent: (...args: unknown[]) => mocks.cloudCodeStream(...args),
}));

const { GeminiChatProvider } = await import('../gemini.js');
const { BedrockChatProvider } = await import('../bedrock.js');
const { consumeStream } = await import('../../core/runner/nodes/executing-stream.js');
import type { ChatRequest } from '../adapter.js';

function request(): ChatRequest {
  return {
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [],
  };
}

function truncatedError(): Record<string, unknown> {
  return {
    name: 'ProviderStreamProtocolError',
    status: 502,
    code: 'stream_ended_no_result',
  };
}

describe('provider native terminal-marker contract', () => {
  beforeEach(() => {
    mocks.geminiGenerate.mockReset();
    mocks.cloudCodeStream.mockReset();
    mocks.bedrockSend.mockReset();
  });

  it('treats Gemini API iterator EOF without candidate.finishReason as truncated', async () => {
    mocks.geminiGenerate.mockResolvedValueOnce((async function* () {
      yield {
        candidates: [{ content: { parts: [{ text: 'partial' }] } }],
      };
    })());

    const provider = new GeminiChatProvider({ apiKey: 'test' });

    await expect(consumeStream({ stream: provider.chat(request()) }))
      .rejects.toMatchObject(truncatedError());
  });

  it('treats Gemini CloudCode SSE EOF without finishReason as truncated', async () => {
    mocks.cloudCodeStream.mockReturnValueOnce((async function* () {
      yield { text: 'partial' };
    })());

    const provider = new GeminiChatProvider({
      accessToken: 'test-token',
      projectId: 'test-project',
    });

    await expect(consumeStream({ stream: provider.chat(request()) }))
      .rejects.toMatchObject(truncatedError());
  });

  it('forwards the current Gemini thinking level through the CloudCode OAuth path', async () => {
    mocks.cloudCodeStream.mockReturnValueOnce((async function* () {
      yield { text: 'ok', finishReason: 'STOP' };
    })());

    const provider = new GeminiChatProvider({
      accessToken: 'test-token',
      projectId: 'test-project',
      model: 'gemini-3.6-flash',
    });
    for await (const _delta of provider.chat({
      ...request(),
      thinking: true,
      reasoningEffort: 'max',
    })) {
      // Drain.
    }

    const payload = mocks.cloudCodeStream.mock.calls.at(-1)![3] as {
      generationConfig?: { thinkingConfig?: unknown };
    };
    expect(payload.generationConfig?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: 'HIGH',
    });
    expect(mocks.cloudCodeStream.mock.calls.at(-1)![6]).toBeUndefined();
  });

  it('treats Bedrock iterator EOF without messageStop as truncated', async () => {
    mocks.bedrockSend.mockResolvedValueOnce({
      stream: (async function* () {
        yield {
          contentBlockDelta: {
            contentBlockIndex: 0,
            delta: { text: 'partial' },
          },
        };
      })(),
    });

    const provider = new BedrockChatProvider({ model: 'test-model' });
    (
      provider as unknown as {
        clientPromise: Promise<{
          client: { send: typeof mocks.bedrockSend };
          sdk: { ConverseStreamCommand: new (input: unknown) => unknown };
        }>;
      }
    ).clientPromise = Promise.resolve({
      client: { send: mocks.bedrockSend },
      sdk: {
        ConverseStreamCommand: class FakeConverseStreamCommand {
          constructor(readonly input: unknown) {}
        },
      },
    });

    await expect(consumeStream({ stream: provider.chat(request()) }))
      .rejects.toMatchObject(truncatedError());
  });
});
