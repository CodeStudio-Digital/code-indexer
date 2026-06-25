/**
 * Fugu (Sakana AI) reasoning-effort wiring on the openai-compat adapter.
 *
 * Fugu's OpenAI-compatible Chat Completions takes the discrete effort as the
 * STRING field `reasoning_effort` (high/xhigh/max). The adapter forwards the
 * user-selected level ONLY for `vendor:'fugu'`, and only when it's set — so the
 * field never leaks to other OpenAI-compatible vendors and an unset effort lets
 * Fugu apply its server-side default (xhigh).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mockCreate } };
  },
}));

const { OpenAIChatProvider } = await import('../openai.js');
import type { ChatRequest } from '../adapter.js';
import type { ChatDelta } from '../../core/messages.js';

/** A minimal one-chunk stream so `chat()` completes. */
function stubStream(): void {
  mockCreate.mockResolvedValueOnce(
    (async function* () {
      yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
    })(),
  );
}

async function drain(req: ChatRequest, vendor: 'fugu' | 'openai'): Promise<void> {
  stubStream();
  const provider = new OpenAIChatProvider({ apiKey: 'k', model: 'fugu', vendor });
  const out: ChatDelta[] = [];
  for await (const d of provider.chat(req)) out.push(d);
}

function baseReq(over: Partial<ChatRequest>): ChatRequest {
  return {
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    ...over,
  } as ChatRequest;
}

function lastBody(): Record<string, unknown> {
  return mockCreate.mock.calls.at(-1)![0] as Record<string, unknown>;
}

describe('OpenAIChatProvider — Fugu reasoning_effort', () => {
  beforeEach(() => mockCreate.mockReset());

  it('sends reasoning_effort as a string when vendor=fugu and effort is set', async () => {
    await drain(baseReq({ reasoningEffort: 'max' }), 'fugu');
    expect(lastBody().reasoning_effort).toBe('max');
  });

  it('forwards xhigh verbatim', async () => {
    await drain(baseReq({ reasoningEffort: 'xhigh' }), 'fugu');
    expect(lastBody().reasoning_effort).toBe('xhigh');
  });

  it('omits reasoning_effort when no effort is selected (Fugu defaults server-side)', async () => {
    await drain(baseReq({}), 'fugu');
    expect(lastBody()).not.toHaveProperty('reasoning_effort');
  });

  it('never sends reasoning_effort for a non-fugu vendor, even with effort set', async () => {
    await drain(baseReq({ reasoningEffort: 'max' }), 'openai');
    expect(lastBody()).not.toHaveProperty('reasoning_effort');
  });
});
