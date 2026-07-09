/**
 * Tests for Wires #1 (Quality Nudge) and #2 (Tool-misuse streak detector).
 *
 * These are PURE-function tests over fixed verdict arrays — no DB, no
 * LLM, no async. They lock in:
 *
 *   - the exact wording of the nudge templates (so we don't accidentally
 *     soften the "execute concretely" message that fixes the
 *     intent-without-execution bug),
 *   - the threshold / dedup behaviors that keep the nudge from going
 *     stale or repeating,
 *   - the streak detector edge cases (mixed ok/error, fewer than 3 rows,
 *     low confidence, …).
 */
import { describe, expect, it } from 'vitest';
import {
  buildQualityNudge,
  detectToolMisuseStreak,
} from '../feedback-builder.js';
import type { QualityClassificationRow } from '@mcp/store/quality-classification-store.js';

function row(partial: Partial<QualityClassificationRow>): QualityClassificationRow {
  return {
    id: 1,
    session_id: 1,
    company_session_id: null,
    agent_run_id: null,
    message_id: 'turn-1',
    classifier_name: 'completeness',
    verdict: 'ok',
    system_error: 0,
    confidence: 0.9,
    reason: null,
    provider_id: null,
    model_id: null,
    latency_ms: null,
    cost_usd: null,
    raw_response_json: null,
    created_at: '2026-05-18 01:00:00',
    ...partial,
  };
}

describe('buildQualityNudge', () => {
  it('returns empty block when no actionable verdicts', () => {
    const result = buildQualityNudge([
      row({ classifier_name: 'completeness', verdict: 'ok' }),
      row({ classifier_name: 'off_topic', verdict: 'ok' }),
    ]);
    expect(result.text).toBe('');
    expect(result.contributingClassifiers).toEqual([]);
  });

  it('emits a corrective hint for completeness=flagged with the "execute" wording', () => {
    const result = buildQualityNudge([
      row({
        classifier_name: 'completeness',
        verdict: 'flagged',
        confidence: 0.95,
        reason: 'Agent only stated intent, did not execute',
      }),
    ]);
    expect(result.contributingClassifiers).toEqual(['completeness']);
    // Lock in the corrective language — this is THE wording that fixes
    // the user's reported failure mode. Don't soften it without thought.
    expect(result.text).toMatch(/EXECUTE: call the tools you described/);
    expect(result.text).toMatch(/Do not narrate — do/);
    // Confidence + reason should appear in the line.
    expect(result.text).toMatch(/95%/);
    expect(result.text).toMatch(/Agent only stated intent/);
  });

  it('emits the "warn" template for warn verdicts (less aggressive)', () => {
    const flaggedText = buildQualityNudge([
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9 }),
    ]).text;
    const warnText = buildQualityNudge([
      row({ classifier_name: 'completeness', verdict: 'warn', confidence: 0.9 }),
    ]).text;
    expect(flaggedText).not.toBe(warnText);
    expect(warnText).toMatch(/Important steps remain/);
    expect(flaggedText).toMatch(/EXECUTE/);
  });

  it('skips verdicts below the confidence floor', () => {
    const result = buildQualityNudge(
      [row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.4 })],
      { minConfidence: 0.6 },
    );
    expect(result.text).toBe('');
  });

  it('keeps only the most recent verdict per classifier (caller passes DESC)', () => {
    const result = buildQualityNudge([
      row({
        id: 2, classifier_name: 'off_topic', verdict: 'flagged', confidence: 0.9,
        reason: 'new evidence',
      }),
      row({
        id: 1, classifier_name: 'off_topic', verdict: 'warn', confidence: 0.9,
        reason: 'old evidence',
      }),
    ]);
    expect(result.contributingClassifiers).toEqual(['off_topic']);
    // Most recent (flagged) wins; old (warn) is dropped.
    expect(result.text).toMatch(/new evidence/);
    expect(result.text).not.toMatch(/old evidence/);
  });

  it('includes one bullet per distinct classifier when multiple fire', () => {
    const result = buildQualityNudge([
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'tool_misuse',  verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'off_topic',    verdict: 'warn',    confidence: 0.8 }),
    ]);
    expect(result.contributingClassifiers).toEqual(['completeness', 'tool_misuse', 'off_topic']);
    expect(result.text.match(/^- \*\*/gm)?.length).toBe(3);
  });

  it('drops rows from unknown classifiers (defensive)', () => {
    const result = buildQualityNudge([
      row({ classifier_name: 'made_up_classifier', verdict: 'flagged', confidence: 0.95 }),
    ]);
    expect(result.text).toBe('');
  });

  it('does not include verdict=error rows (those are noise, not signal)', () => {
    const result = buildQualityNudge([
      row({ classifier_name: 'completeness', verdict: 'error', confidence: 0 }),
    ]);
    expect(result.text).toBe('');
  });

  it('caps the output at 5 hints', () => {
    // 6 different classifiers with hints — but we only template 5.
    const inputs: QualityClassificationRow[] = [
      row({ classifier_name: 'off_topic',    verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'code_quality', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'policy',       verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'tool_misuse',  verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'unknown_one',  verdict: 'flagged', confidence: 0.9 }),
    ];
    const result = buildQualityNudge(inputs);
    // Unknown is dropped, plus we cap at 5.
    expect(result.contributingClassifiers.length).toBe(5);
  });

  it('preserves reason but truncates aggressively to keep prompt small', () => {
    const longReason = 'A'.repeat(500);
    const result = buildQualityNudge([
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9, reason: longReason }),
    ]);
    expect(result.text).toContain('AAAA');
    // The truncator is 220 chars + ellipsis.
    expect(result.text).toMatch(/A{200,250}…/);
  });
});

describe('detectToolMisuseStreak', () => {
  it('triggers on 3 consecutive tool_misuse=flagged', () => {
    const result = detectToolMisuseStreak([
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9, reason: 'latest' }),
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.8 }),
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.7 }),
    ]);
    expect(result.triggered).toBe(true);
    expect(result.latestReason).toBe('latest');
    expect(result.latestConfidence).toBe(0.9);
  });

  it('does NOT trigger when fewer than 3 rows match', () => {
    const result = detectToolMisuseStreak([
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
    ]);
    expect(result.triggered).toBe(false);
  });

  it('does NOT trigger when one of the 3 is not flagged', () => {
    const result = detectToolMisuseStreak([
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'tool_misuse', verdict: 'warn',    confidence: 0.9 }),
      row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
    ]);
    expect(result.triggered).toBe(false);
  });

  it('ignores classifiers other than tool_misuse', () => {
    const result = detectToolMisuseStreak([
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9 }),
      row({ classifier_name: 'completeness', verdict: 'flagged', confidence: 0.9 }),
    ]);
    expect(result.triggered).toBe(false);
  });

  it('skips verdict=error rows without breaking the streak', () => {
    // Pattern: flagged, ERROR (provider failure), flagged, flagged.
    // The error is noise and should not block the streak.
    const result = detectToolMisuseStreak([
      row({ id: 4, classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
      row({ id: 3, classifier_name: 'tool_misuse', verdict: 'error',   confidence: 0   }),
      row({ id: 2, classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
      row({ id: 1, classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
    ]);
    expect(result.triggered).toBe(true);
  });

  it('requires confidence above the floor for every member of the streak', () => {
    const result = detectToolMisuseStreak(
      [
        row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
        row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.3 }),
        row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
      ],
      { minConfidence: 0.5 },
    );
    expect(result.triggered).toBe(false);
  });

  it('respects a custom streak length', () => {
    const r2 = detectToolMisuseStreak(
      [
        row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
        row({ classifier_name: 'tool_misuse', verdict: 'flagged', confidence: 0.9 }),
      ],
      { streakLength: 2 },
    );
    expect(r2.triggered).toBe(true);
  });

  it('returns empty payload when nothing triggers', () => {
    const result = detectToolMisuseStreak([]);
    expect(result.triggered).toBe(false);
    expect(result.latestReason).toBeNull();
    expect(result.latestConfidence).toBeNull();
  });
});
