/**
 * Regression: the public `CoderRunner.turn` mirror must track the
 * loop-local `RunContext.turn` (incremented by the Executing node).
 *
 * The bug: the docstring on `CoderRunner.turn` promised a mirror, but no
 * code ever wrote it — it stayed frozen at 0 for the whole run. Every
 * Quality v2 turn-accounting consumer read the dead mirror:
 *   - `recordIntervention` persisted `turn_fired = 0`, which the backfill
 *     can never score (`findPendingByPriorTurnRange` clamps minTurn to 1),
 *     so the dashboard showed 100% PENDING / no improvement rate, ever.
 *   - `shouldClassifyTurn({turn: 0})` stayed inside the warmup window
 *     forever, over-classifying every turn.
 *
 * The fix intercepts `turn_start` in the BT emit bridge
 * (runViaBehaviorTree) and assigns `this.turn` BEFORE forwarding to
 * listeners.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { ToolRegistry } from '@mcp/code-agent/core/registry.js';
import {
  setGlobalQualityClassificationStore,
  setGlobalQualityInterventionStore,
} from '@mcp/services/quality/index.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { ChatDelta } from '@mcp/code-agent/core/messages.js';

class StubProvider implements ChatProvider {
  readonly name = 'stub';
  model = 'stub-1';
  setModel(m: string) { this.model = m; }
  async *chat(_req: ChatRequest): AsyncIterable<ChatDelta> {
    yield { type: 'text_delta', text: 'final answer, no tool calls' };
    yield { type: 'done' };
  }
}

function makeRunner(opts: { sessionId?: number } = {}) {
  return new CoderRunner({
    provider: new StubProvider(),
    registry: new ToolRegistry(),
    systemPrompt: 'test',
    toolContext: { cwd: '/tmp', projectName: 'test' },
    sessionId: opts.sessionId,
  });
}

afterEach(() => {
  setGlobalQualityClassificationStore(undefined);
  setGlobalQualityInterventionStore(undefined);
});

describe('CoderRunner.turn mirror (turn_start)', () => {
  it('starts at 0 and tracks each turn_start before listeners observe it', async () => {
    const runner = makeRunner();
    expect(runner.turn).toBe(0);

    // The mirror must be updated BEFORE the event reaches listeners —
    // listeners (flushPendingTurn, SnapshotRecorder, …) read `runner.turn`.
    const seen: Array<{ arg: number; mirror: number }> = [];
    runner.on('turn_start', (t) => seen.push({ arg: t, mirror: runner.turn }));

    runner.pushUserMessage('hello');
    await runner.run();

    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.mirror).toBe(s.arg);
    // Single-turn run: the mirror ends at 1, not frozen at 0.
    expect(runner.turn).toBe(1);
  });

  it('recordIntervention persists turn_fired > 0 (backfill can score it)', async () => {
    // Fake classification store: one fresh actionable verdict so
    // `buildQualityFeedbackSuffix` emits (or holds out) a nudge on turn 1.
    const row = {
      id: 1,
      session_id: 42,
      classifier_name: 'completeness',
      verdict: 'warn',
      confidence: 0.9,
      reason: 'stated intent but did not act',
      message_id: 'turn-0',
      created_at: new Date().toISOString(),
    };
    setGlobalQualityClassificationStore({
      findRecentBySession: () => [row],
    } as never);

    const inserts: Array<Record<string, unknown>> = [];
    setGlobalQualityInterventionStore({
      insert: (r: Record<string, unknown>) => { inserts.push(r); return 1; },
    } as never);

    const runner = makeRunner({ sessionId: 42 });
    runner.pushUserMessage('hello');
    await runner.run();

    // nudge OR nudge_holdout (deterministic per session/turn) — either way
    // the row must carry the REAL turn, not the frozen 0.
    expect(inserts.length).toBeGreaterThan(0);
    for (const r of inserts) {
      expect(r.turn_fired).toBe(1);
    }
  });
});
