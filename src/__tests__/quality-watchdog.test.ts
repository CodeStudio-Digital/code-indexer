/**
 * QualityWatchdog tests — covers the pre-filter heuristic and the
 * end-to-end analyze() path with a stubbed runChat.
 *
 * The pre-filter is the hot path (runs every turn); the LLM call only
 * fires when the pre-filter says "this looks suspicious". Tests
 * exercise both:
 *
 *   1. `shouldRun` returns null when the window is below threshold or
 *      when no tool dominates.
 *   2. `shouldRun` returns `{suspectTool, count}` for the session-722
 *      pattern: ≥4 of the same tool in last 5 turns.
 *   3. `analyze` parses the LLM response (markdown fences, <think>,
 *      preamble — all tolerated) and bubbles errors as 'error' verdicts.
 */
import { describe, it, expect } from 'vitest';
import { QualityWatchdog } from '@mcp/services/quality/QualityWatchdog.js';
import type { WatchdogChatRunner } from '@mcp/services/quality/QualityWatchdog.js';

function makeWatchdog(runChat: WatchdogChatRunner): QualityWatchdog {
  return new QualityWatchdog({
    provider: 'test',
    model: 'test-model',
    runChat,
    prefilterCount: 4,
    prefilterWindow: 5,
    cooldownTurns: 5,
  });
}

describe('QualityWatchdog.shouldRun (pre-filter)', () => {
  const wd = makeWatchdog(async () => ({ text: '' }));

  it('returns null on an empty window', () => {
    expect(wd.shouldRun([])).toBeNull();
  });

  it('returns null when the window is below the threshold count', () => {
    // 3 calls total — needs ≥4 to fire
    expect(wd.shouldRun(['update_todo', 'update_todo', 'update_todo'])).toBeNull();
  });

  it('returns null when no single tool dominates 4/5', () => {
    // [a,b,a,b,a] → top is `a` at 3, below the threshold of 4.
    expect(wd.shouldRun(['a', 'b', 'a', 'b', 'a'])).toBeNull();
  });

  it('fires when the same tool runs 4 of 5 turns (session 722 pattern)', () => {
    const trigger = wd.shouldRun([
      'update_todo',
      'read_file',
      'update_todo',
      'update_todo',
      'update_todo',
    ]);
    expect(trigger).toEqual({ suspectTool: 'update_todo', count: 4 });
  });

  it('fires when ALL 5 of 5 are the same tool', () => {
    const trigger = wd.shouldRun(['x', 'x', 'x', 'x', 'x']);
    expect(trigger).toEqual({ suspectTool: 'x', count: 5 });
  });

  it('only counts the LAST window-size entries (older calls ignored)', () => {
    // Older [a,a,a] doesn't count — last 5 are [b,a,a,a,a]
    const trigger = wd.shouldRun(['a', 'a', 'a', 'b', 'a', 'a', 'a', 'a']);
    expect(trigger).toEqual({ suspectTool: 'a', count: 4 });
  });
});

describe('QualityWatchdog.analyze (LLM path)', () => {
  const sampleInput = {
    sessionId: 722,
    turn: 12,
    recentToolCalls: [
      { turn: 8, name: 'update_todo', isError: false, argsPreview: '{}' },
      { turn: 9, name: 'update_todo', isError: false, argsPreview: '{}' },
      { turn: 10, name: 'update_todo', isError: true, argsPreview: '{}' },
      { turn: 11, name: 'update_todo', isError: false, argsPreview: '{}' },
      { turn: 12, name: 'update_todo', isError: false, argsPreview: '{}' },
    ],
    lastAssistantText: 'Marking the todo as in_progress',
  };

  it('parses a clean JSON response', async () => {
    const wd = makeWatchdog(async () => ({
      text: JSON.stringify({
        verdict: 'flagged',
        confidence: 0.85,
        reason: 'update_todo dominates 5/5 with no progress',
        recommended_action: 'nudge',
      }),
    }));
    const v = await wd.analyze(sampleInput);
    expect(v.verdict).toBe('flagged');
    expect(v.confidence).toBe(0.85);
    expect(v.reason).toContain('update_todo');
    expect(v.recommendedAction).toBe('nudge');
    expect(v.classifierName).toBe('tool_loop');
    expect(v.providerId).toBe('test');
    expect(v.modelId).toBe('test-model');
  });

  it('tolerates markdown ```json fences (some models still wrap output)', async () => {
    const wd = makeWatchdog(async () => ({
      text: '```json\n{"verdict":"warn","confidence":0.5,"reason":"some repetition","recommended_action":"ok"}\n```',
    }));
    const v = await wd.analyze(sampleInput);
    expect(v.verdict).toBe('warn');
    expect(v.recommendedAction).toBe('ok');
  });

  it('strips <think> reasoning blocks before parsing', async () => {
    const wd = makeWatchdog(async () => ({
      text:
        '<think>Hmm, the agent has been calling update_todo a lot...</think>\n' +
        '{"verdict":"flagged","confidence":0.9,"reason":"clear loop","recommended_action":"stop"}',
    }));
    const v = await wd.analyze(sampleInput);
    expect(v.verdict).toBe('flagged');
    expect(v.recommendedAction).toBe('stop');
  });

  it('returns error verdict when the LLM emits unparseable output', async () => {
    const wd = makeWatchdog(async () => ({ text: 'I think the agent is fine. No JSON for you.' }));
    const v = await wd.analyze(sampleInput);
    expect(v.verdict).toBe('error');
    expect(v.recommendedAction).toBe('ok');
  });

  it('returns error verdict when the runChat throws', async () => {
    const wd = makeWatchdog(async () => {
      throw new Error('provider down');
    });
    const v = await wd.analyze(sampleInput);
    expect(v.verdict).toBe('error');
    expect(v.reason).toContain('provider down');
    expect(v.recommendedAction).toBe('ok');
  });

  it('coerces unknown verdict strings to "error"', async () => {
    const wd = makeWatchdog(async () => ({
      text: '{"verdict":"sketchy","confidence":0.5,"reason":"...","recommended_action":"nudge"}',
    }));
    const v = await wd.analyze(sampleInput);
    expect(v.verdict).toBe('error');
  });

  it('coerces unknown recommended_action to "ok"', async () => {
    const wd = makeWatchdog(async () => ({
      text: '{"verdict":"flagged","confidence":0.5,"reason":"...","recommended_action":"destroy"}',
    }));
    const v = await wd.analyze(sampleInput);
    expect(v.recommendedAction).toBe('ok');
  });
});
