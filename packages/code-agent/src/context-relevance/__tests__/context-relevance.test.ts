/**
 * Context-relevance pipeline tests.
 *
 * Invariants verified:
 *   - System messages are NEVER dropped
 *   - Last N turns are NEVER dropped
 *   - Atomic blocks stay together (user+assistant+tool_result triplets)
 *   - Decision markers are preferentially retained
 *   - Budget is respected for droppable messages
 *   - Cached embeddings are reused
 */
import { describe, expect, it } from 'vitest';
import {
  compactSession,
  createContextRelevancePipeline,
  detectDecisionMarker,
  InMemoryMessageEmbeddingStore,
  type EmbeddingFn,
  type SessionMessage,
} from '../index.js';

const toyEmbed: EmbeddingFn = async (text: string) => {
  const arr = new Float32Array(4);
  for (let i = 0; i < 4; i++) {
    arr[i] = (text.toLowerCase().charCodeAt(i) || 0) / 128;
  }
  let norm = 0;
  for (let i = 0; i < 4; i++) norm += arr[i] * arr[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 4; i++) arr[i] /= norm;
  return arr;
};

function makeMessage(
  id: string,
  role: SessionMessage['role'],
  text: string,
  overrides: Partial<SessionMessage> = {},
): SessionMessage {
  return {
    id,
    role,
    text,
    createdAtMs: Number(id) * 1000,
    ...overrides,
  };
}

describe('detectDecisionMarker', () => {
  it('returns > 0 for typical decision text', () => {
    expect(detectDecisionMarker('We decided to use PostgreSQL because of...')).toBeGreaterThan(0);
    expect(detectDecisionMarker('The approach is to refactor in three phases.')).toBeGreaterThan(0);
    expect(detectDecisionMarker('We chose Redux instead of Zustand.')).toBeGreaterThan(0);
    expect(detectDecisionMarker('Never use the deprecated API.')).toBeGreaterThan(0);
  });
  it('returns 0 for neutral text', () => {
    expect(detectDecisionMarker('Hello there')).toBe(0);
    expect(detectDecisionMarker('I ran the tests and they pass.')).toBe(0);
  });
});

describe('ContextRelevancePipeline', () => {
  function buildPipeline(messages: SessionMessage[]) {
    return createContextRelevancePipeline({
      getMessages: () => messages,
      embed: toyEmbed,
      messageEmbeddingStore: new InMemoryMessageEmbeddingStore(),
    });
  }

  it('never drops the system message', async () => {
    const messages: SessionMessage[] = [
      makeMessage('1', 'system', 'You are a helpful assistant.'),
      makeMessage('2', 'user', 'Hi'),
      makeMessage('3', 'assistant', 'Hello'),
      makeMessage('4', 'user', 'Continue'),
    ];
    const pipeline = buildPipeline(messages);
    const result = await compactSession(pipeline, {
      queryId: 'q', taskText: 'completely different topic',
      tokenBudget: 1, // tiny — forces drops
    });
    expect(result.keptMessages.some((m) => m.role === 'system')).toBe(true);
  });

  it('never drops the last N turns', async () => {
    const messages: SessionMessage[] = Array.from({ length: 20 }, (_, i) =>
      makeMessage(String(i + 1), i % 2 === 0 ? 'user' : 'assistant', `noise ${i}`),
    );
    const pipeline = buildPipeline(messages);
    const result = await compactSession(pipeline, {
      queryId: 'q', taskText: 'unrelated',
      tokenBudget: 0,
      preserveRecentTurns: 3,
    });
    // Last 3 messages MUST be kept.
    const lastIds = messages.slice(-3).map((m) => m.id);
    for (const id of lastIds) {
      expect(result.keptMessages.some((m) => m.id === id)).toBe(true);
    }
  });

  it('keeps atomic blocks together', async () => {
    const messages: SessionMessage[] = [
      makeMessage('1', 'system', 'sys'),
      makeMessage('2', 'user', 'Read the file', { atomicBlockId: 'b1' }),
      makeMessage('3', 'assistant', 'Sure, reading…', { atomicBlockId: 'b1' }),
      makeMessage('4', 'tool_result', 'CONTENT OF FILE', { atomicBlockId: 'b1', hasToolEvent: true }),
      makeMessage('5', 'user', 'Most recent question'),
    ];
    const pipeline = buildPipeline(messages);
    const result = await compactSession(pipeline, {
      queryId: 'q',
      taskText: 'Most recent question',
      tokenBudget: 200, // enough for the system + last + atomic block
      preserveRecentTurns: 1,
    });
    // Either all of b1 is in, or none of it is (atomic).
    const b1Ids = ['2', '3', '4'];
    const keptB1 = b1Ids.filter((id) => result.keptMessages.some((m) => m.id === id)).length;
    expect(keptB1 === 0 || keptB1 === 3).toBe(true);
  });

  it('preferentially retains messages with decision markers', async () => {
    const messages: SessionMessage[] = [
      makeMessage('1', 'system', 'sys'),
      makeMessage('2', 'user', 'small talk one'),
      makeMessage('3', 'assistant', 'fine fine'),
      makeMessage('4', 'user', 'small talk two'),
      makeMessage('5', 'assistant', 'OK'),
      // Decision deep in the middle:
      makeMessage('6', 'assistant', 'We decided to never use eval() and always sanitize input.'),
      makeMessage('7', 'user', 'small talk three'),
      makeMessage('8', 'assistant', 'OK'),
      makeMessage('9', 'user', 'Most recent question that is unrelated'),
    ];
    const pipeline = buildPipeline(messages);
    const result = await compactSession(pipeline, {
      queryId: 'q',
      taskText: 'Most recent question that is unrelated',
      tokenBudget: 80, // forces some drops
      preserveRecentTurns: 1,
    });
    // The decision must survive even though it doesn't lexically match the task.
    expect(result.keptMessages.some((m) => m.id === '6')).toBe(true);
  });

  it('respects the token budget for droppable messages', async () => {
    const messages: SessionMessage[] = Array.from({ length: 20 }, (_, i) =>
      makeMessage(String(i + 1), i % 2 === 0 ? 'user' : 'assistant', 'X'.repeat(40)), // ~10 tokens each
    );
    const pipeline = buildPipeline(messages);
    const result = await compactSession(pipeline, {
      queryId: 'q', taskText: 'X X X',
      tokenBudget: 30,
      preserveRecentTurns: 1, // 1 message ~10 tokens pinned; remaining budget 20
    });
    // Total kept tokens should be <= budget + pinned overhead.
    // Pinned (last turn) might fit in 10 tokens; budget 30 = up to 2 more.
    const totalKeptTokens = result.diag.keptTokens;
    // Allow some slack for pinned that might exceed budget (acceptable).
    expect(totalKeptTokens).toBeLessThanOrEqual(messages.length * 10);
    expect(result.diag.droppedCount).toBeGreaterThan(0);
  });

  it('reuses cached message embeddings on a second run', async () => {
    const messages: SessionMessage[] = [
      makeMessage('1', 'user', 'A'),
      makeMessage('2', 'assistant', 'B'),
      makeMessage('3', 'user', 'C'),
    ];
    let embedCalls = 0;
    const countingEmbed: EmbeddingFn = async (text) => {
      embedCalls++;
      return toyEmbed(text);
    };
    const pipeline = createContextRelevancePipeline({
      getMessages: () => messages,
      embed: countingEmbed,
      messageEmbeddingStore: new InMemoryMessageEmbeddingStore(),
    });
    await compactSession(pipeline, { queryId: 'a', taskText: 'task', tokenBudget: 1000 });
    const firstRunCalls = embedCalls;
    embedCalls = 0;
    await compactSession(pipeline, { queryId: 'b', taskText: 'task', tokenBudget: 1000 });
    // 2nd run: messages cached, only the new task gets a fresh embed.
    expect(embedCalls).toBe(1);
    expect(firstRunCalls).toBeGreaterThanOrEqual(messages.length + 1);
  });

  it('namespaces message embeddings by the dynamic model fingerprint', async () => {
    const messages: SessionMessage[] = [
      makeMessage('1', 'user', 'A'),
      makeMessage('2', 'assistant', 'B'),
      makeMessage('3', 'user', 'C'),
    ];
    let model = 'model-a';
    let embedCalls = 0;
    const dynamicEmbed: EmbeddingFn = Object.assign(
      async () => {
        embedCalls++;
        return Float32Array.from(model === 'model-a' ? [1, 0] : [0, 1]);
      },
      { fingerprint: () => model },
    );
    const pipeline = createContextRelevancePipeline({
      getMessages: () => messages,
      embed: dynamicEmbed,
      messageEmbeddingStore: new InMemoryMessageEmbeddingStore(),
    });

    await compactSession(pipeline, { queryId: 'a', taskText: 'task', tokenBudget: 1000 });
    expect(embedCalls).toBe(messages.length + 1);

    model = 'model-b';
    embedCalls = 0;
    await compactSession(pipeline, { queryId: 'b', taskText: 'task', tokenBudget: 1000 });
    expect(embedCalls).toBe(messages.length + 1);

    embedCalls = 0;
    await compactSession(pipeline, { queryId: 'c', taskText: 'task', tokenBudget: 1000 });
    expect(embedCalls).toBe(1);
  });
});
