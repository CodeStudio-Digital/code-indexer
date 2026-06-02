/**
 * Tests for `QualityInterventionStore` — Quality v2 C2.
 *
 * Covers:
 *   - insert + get round-trip with verdict snapshot serialization
 *   - findPendingByPriorTurn returns only matching pending rows
 *   - recordOutcome flips status and stores next-turn verdicts
 *   - effectivenessStats aggregates correctly with improved-rate
 *   - recordOutcome is idempotent (won't re-update non-pending rows)
 *   - pruneOlderThan respects the cutoff
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../db.js';
import {
  QualityInterventionStore,
  type InterventionVerdictSnapshot,
} from '../quality-intervention-store.js';

interface Handle {
  db: CodeIndexDB;
  store: QualityInterventionStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-qiv-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new QualityInterventionStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function snap(verdict: 'ok' | 'warn' | 'flagged' | 'error', name = 'off_topic'): InterventionVerdictSnapshot {
  return { classifierName: name, verdict, confidence: 0.9, reason: `reason for ${name}` };
}

describe('QualityInterventionStore — insert + get', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('round-trips a nudge intervention with verdict snapshot', () => {
    const id = h.store.insert({
      session_id: 1,
      agent_run_id: 42,
      turn_fired: 10,
      intervention_type: 'nudge',
      triggering_verdicts: [snap('flagged', 'completeness'), snap('warn', 'tool_misuse')],
      nudge_chars: 800,
    });
    expect(id).toBeGreaterThan(0);
    const row = h.store.get(id);
    expect(row).not.toBeNull();
    expect(row!.intervention_type).toBe('nudge');
    expect(row!.outcome).toBe('pending');
    expect(row!.nudge_chars).toBe(800);
    expect(row!.triggering_classifiers).toBe('completeness,tool_misuse');
    // Snapshot serialized as JSON.
    const parsed = JSON.parse(row!.triggering_verdicts_json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].classifierName).toBe('completeness');
  });

  it('dedupes triggering_classifiers (same name appearing twice)', () => {
    const id = h.store.insert({
      session_id: 1,
      turn_fired: 1,
      intervention_type: 'nudge',
      triggering_verdicts: [
        snap('flagged', 'tool_misuse'),
        snap('warn', 'tool_misuse'), // same name → dedup
      ],
    });
    const row = h.store.get(id)!;
    expect(row.triggering_classifiers).toBe('tool_misuse');
  });
});

describe('QualityInterventionStore — findPendingByPriorTurn', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns pending rows for the matching session + turn', () => {
    h.store.insert({ session_id: 1, turn_fired: 5, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    h.store.insert({ session_id: 1, turn_fired: 5, intervention_type: 'planning', triggering_verdicts: [snap('flagged')] });
    h.store.insert({ session_id: 1, turn_fired: 6, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    h.store.insert({ session_id: 2, turn_fired: 5, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });

    const rows = h.store.findPendingByPriorTurn(1, 5);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.session_id === 1 && r.turn_fired === 5)).toBe(true);
  });

  it('omits rows that already have an outcome recorded', () => {
    const id = h.store.insert({ session_id: 1, turn_fired: 5, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    h.store.recordOutcome({ id, next_turn_verdicts: [snap('ok')], outcome: 'improved' });
    expect(h.store.findPendingByPriorTurn(1, 5)).toEqual([]);
  });

  it('returns empty when no rows match', () => {
    h.store.insert({ session_id: 1, turn_fired: 5, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    expect(h.store.findPendingByPriorTurn(999, 5)).toEqual([]);
    expect(h.store.findPendingByPriorTurn(1, 99)).toEqual([]);
  });
});

describe('QualityInterventionStore — findPendingByPriorTurnRange', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns pending rows whose turn_fired is within [min, max], oldest-first', () => {
    h.store.insert({ session_id: 1, turn_fired: 3, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    h.store.insert({ session_id: 1, turn_fired: 5, intervention_type: 'nudge_holdout', triggering_verdicts: [snap('flagged')] });
    h.store.insert({ session_id: 1, turn_fired: 2, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] }); // below range
    h.store.insert({ session_id: 1, turn_fired: 7, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] }); // above range
    const rows = h.store.findPendingByPriorTurnRange(1, 3, 5);
    expect(rows.map((r) => r.turn_fired)).toEqual([3, 5]);
  });

  it('excludes already-resolved rows and other sessions', () => {
    const id = h.store.insert({ session_id: 1, turn_fired: 4, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    h.store.recordOutcome({ id, next_turn_verdicts: [snap('ok')], outcome: 'improved' });
    h.store.insert({ session_id: 2, turn_fired: 4, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    expect(h.store.findPendingByPriorTurnRange(1, 1, 6)).toEqual([]);
  });

  it('round-trips a nudge_holdout intervention (counterfactual baseline type)', () => {
    const id = h.store.insert({
      session_id: 1, turn_fired: 9, intervention_type: 'nudge_holdout',
      triggering_verdicts: [snap('flagged', 'completeness')],
    });
    expect(h.store.get(id)!.intervention_type).toBe('nudge_holdout');
  });
});

describe('QualityInterventionStore — recordOutcome', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('updates outcome + next_turn_verdicts_json + outcome_recorded_at', () => {
    const id = h.store.insert({
      session_id: 1,
      turn_fired: 5,
      intervention_type: 'nudge',
      triggering_verdicts: [snap('flagged', 'completeness')],
    });
    const ok = h.store.recordOutcome({
      id,
      next_turn_verdicts: [snap('ok', 'completeness')],
      outcome: 'improved',
    });
    expect(ok).toBe(true);
    const row = h.store.get(id)!;
    expect(row.outcome).toBe('improved');
    expect(row.outcome_recorded_at).not.toBeNull();
    expect(row.next_turn_verdicts_json).toContain('"verdict":"ok"');
  });

  it('returns false when row is already non-pending (idempotent)', () => {
    const id = h.store.insert({
      session_id: 1, turn_fired: 5, intervention_type: 'nudge',
      triggering_verdicts: [snap('flagged')],
    });
    expect(h.store.recordOutcome({ id, next_turn_verdicts: [snap('ok')], outcome: 'improved' })).toBe(true);
    // Second call must NOT clobber the first result.
    expect(h.store.recordOutcome({ id, next_turn_verdicts: [snap('flagged')], outcome: 'worsened' })).toBe(false);
    expect(h.store.get(id)!.outcome).toBe('improved');
  });

  it('returns false when row does not exist', () => {
    expect(h.store.recordOutcome({ id: 999, next_turn_verdicts: [snap('ok')], outcome: 'improved' })).toBe(false);
  });
});

describe('QualityInterventionStore — effectivenessStats', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  function plantOutcome(turn: number, type: 'nudge' | 'planning' | 'nudge_suppressed', outcome: 'improved' | 'unchanged' | 'worsened' | 'pending') {
    const id = h.store.insert({ session_id: 1, turn_fired: turn, intervention_type: type, triggering_verdicts: [snap('flagged')] });
    if (outcome !== 'pending') {
      h.store.recordOutcome({ id, next_turn_verdicts: [snap(outcome === 'improved' ? 'ok' : 'flagged')], outcome });
    }
    return id;
  }

  it('aggregates per-type with improved_rate computed correctly', () => {
    plantOutcome(1, 'nudge', 'improved');
    plantOutcome(2, 'nudge', 'improved');
    plantOutcome(3, 'nudge', 'unchanged');
    plantOutcome(4, 'nudge', 'worsened');
    plantOutcome(5, 'nudge', 'pending');
    plantOutcome(6, 'planning', 'improved');
    plantOutcome(7, 'planning', 'unchanged');

    const stats = h.store.effectivenessStats();
    expect(stats.byType).toHaveLength(2);

    const nudge = stats.byType.find((r) => r.intervention_type === 'nudge')!;
    expect(nudge.improved).toBe(2);
    expect(nudge.unchanged).toBe(1);
    expect(nudge.worsened).toBe(1);
    expect(nudge.pending).toBe(1);
    expect(nudge.measured).toBe(4); // pending excluded from "measured"
    expect(nudge.improved_rate).toBe(0.5); // 2 / 4

    const planning = stats.byType.find((r) => r.intervention_type === 'planning')!;
    expect(planning.improved_rate).toBe(0.5);
  });

  it('handles all-pending case (measured=0 → improved_rate=0)', () => {
    plantOutcome(1, 'nudge', 'pending');
    plantOutcome(2, 'nudge', 'pending');
    const stats = h.store.effectivenessStats();
    expect(stats.byType[0].measured).toBe(0);
    expect(stats.byType[0].improved_rate).toBe(0);
  });

  it('recent list ordered newest-first, capped by recentLimit', () => {
    for (let i = 1; i <= 25; i++) {
      h.store.insert({ session_id: 1, turn_fired: i, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')] });
    }
    const stats = h.store.effectivenessStats({ recentLimit: 10 });
    expect(stats.recent).toHaveLength(10);
    // Highest turn first (the SQL orders by created_at DESC + id DESC, so
    // the most-recently-inserted appears first).
    expect(stats.recent[0].turn_fired).toBe(25);
  });

  it('honors the `since` filter', () => {
    const oldId = h.store.insert({
      session_id: 1, turn_fired: 1, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')],
    });
    h.db.raw().prepare(`UPDATE quality_interventions SET created_at = ? WHERE id = ?`)
      .run('2020-01-01 00:00:00', oldId);
    h.store.insert({
      session_id: 1, turn_fired: 2, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')],
    });
    const stats = h.store.effectivenessStats({ since: '2026-01-01' });
    expect(stats.byType[0].pending + stats.byType[0].improved + stats.byType[0].unchanged + stats.byType[0].worsened).toBe(1);
  });
});

describe('QualityInterventionStore — pruneOlderThan', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('removes rows older than the cutoff', () => {
    const oldId = h.store.insert({
      session_id: 1, turn_fired: 1, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')],
    });
    h.db.raw().prepare(`UPDATE quality_interventions SET created_at = ? WHERE id = ?`)
      .run('2020-01-01 00:00:00', oldId);
    h.store.insert({
      session_id: 1, turn_fired: 2, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')],
    });
    const deleted = h.store.pruneOlderThan('2026-01-01');
    expect(deleted).toBe(1);
    expect(h.store.get(oldId)).toBeNull();
  });

  it('clearAll drops every row regardless of age', () => {
    const id1 = h.store.insert({
      session_id: 1, turn_fired: 1, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')],
    });
    const id2 = h.store.insert({
      session_id: 1, turn_fired: 2, intervention_type: 'nudge', triggering_verdicts: [snap('flagged')],
    });
    const deleted = h.store.clearAll();
    expect(deleted).toBe(2);
    expect(h.store.get(id1)).toBeNull();
    expect(h.store.get(id2)).toBeNull();
  });
});
