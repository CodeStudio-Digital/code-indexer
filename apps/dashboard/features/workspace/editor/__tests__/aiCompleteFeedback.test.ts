import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../../lib/api-client.js', () => ({ apiCall: vi.fn(() => Promise.resolve({ ok: true })) }));

import { apiCall } from '../../../../lib/api-client.js';
import {
  noteShown, notePartial, noteAccept, noteFreed, anyTracked,
  __resetAiFeedbackForTests, DO_NOT_COUNT_REJECTED_BEFORE_MS,
} from '../aiCompleteFeedback.js';

const mockApi = vi.mocked(apiCall);

function sentActions(): Array<Record<string, unknown>> {
  return mockApi.mock.calls.map(([, body]) => body as Record<string, unknown>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  __resetAiFeedbackForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('aiCompleteFeedback tracker', () => {
  it('dedupes shown per requestId (cache hits re-show the same id)', () => {
    noteShown(1, 'req-1');
    noteShown(1, 'req-1');
    noteShown(1, 'req-1');
    expect(sentActions().filter((b) => b.action === 'shown')).toHaveLength(1);
    expect(anyTracked()).toBe(true);
  });

  it('freed under 250ms is typing churn — no reject', () => {
    noteShown(1, 'req-1');
    vi.advanceTimersByTime(DO_NOT_COUNT_REJECTED_BEFORE_MS - 50);
    noteFreed('req-1');
    expect(sentActions().some((b) => b.action === 'reject')).toBe(false);
    expect(anyTracked()).toBe(false);
  });

  it('freed after 250ms without accept sends a reject with shownForMs', () => {
    noteShown(1, 'req-1');
    vi.advanceTimersByTime(400);
    noteFreed('req-1');
    const reject = sentActions().find((b) => b.action === 'reject')!;
    expect(reject.requestId).toBe('req-1');
    expect(reject.shownForMs).toBeGreaterThanOrEqual(400);
  });

  it('accept suppresses the reject on free', () => {
    noteShown(1, 'req-1');
    vi.advanceTimersByTime(500);
    noteAccept(1, 'req-1');
    noteFreed('req-1');
    const actions = sentActions().map((b) => b.action);
    expect(actions).toContain('accept');
    expect(actions).not.toContain('reject');
  });

  it('partial chars turn the free into a partial event (cumulative max wins)', () => {
    noteShown(1, 'req-1');
    notePartial(1, 'req-1', 4, 'word');
    notePartial(1, 'req-1', 11, 'line');
    vi.advanceTimersByTime(500);
    noteFreed('req-1');
    const partial = sentActions().find((b) => b.action === 'partial')!;
    expect(partial.acceptedChars).toBe(11);
    expect(partial.partialKind).toBe('line');
    expect(sentActions().some((b) => b.action === 'reject')).toBe(false);
  });

  it('freeing an unknown requestId (never shown) does nothing', () => {
    noteFreed('ghost');
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('apiCall failures are swallowed', () => {
    mockApi.mockRejectedValueOnce(new Error('offline'));
    expect(() => noteShown(1, 'req-1')).not.toThrow();
  });
});
