/**
 * Tests for `QualityClassificationStore` — the new query methods that
 * back Wires #1, #2, and #3:
 *
 *   - `findRecentBySession` — used by Wire #1/#2 to pull last verdicts
 *     for the current session.
 *   - `findRecentByAgentRunIds` — used by Wire #3 (kanban gate) to fan
 *     out to a card's agents.
 *
 * Existing methods (`insert`, `listByAgentRun`, `listByClassifier`,
 * `verdictDistribution`) are covered by the quality-pipeline integration
 * test. This file focuses on the two NEW methods.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { CodeIndexDB } from '../db.js';
import { QualityClassificationStore } from '../quality-classification-store.js';

interface Handle {
  db: CodeIndexDB;
  store: QualityClassificationStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-qstore-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new QualityClassificationStore(db.raw()), dir };
}

function teardown(h: Handle): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

describe('findRecentBySession', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns empty when no rows match', () => {
    expect(h.store.findRecentBySession(999)).toEqual([]);
  });

  it('returns rows for the given session, newest first', () => {
    h.store.insert({ session_id: 1, classifier_name: 'off_topic',    verdict: 'ok' });
    h.store.insert({ session_id: 1, classifier_name: 'completeness', verdict: 'warn', confidence: 0.8 });
    h.store.insert({ session_id: 2, classifier_name: 'off_topic',    verdict: 'flagged' }); // different session
    const rows = h.store.findRecentBySession(1);
    expect(rows.length).toBe(2);
    // DESC by created_at + id — the most recently inserted is first.
    expect(rows[0].classifier_name).toBe('completeness');
    expect(rows[1].classifier_name).toBe('off_topic');
    // Cross-session leakage check.
    expect(rows.every((r) => r.session_id === 1)).toBe(true);
  });

  it('filters by classifier name when requested', () => {
    h.store.insert({ session_id: 1, classifier_name: 'tool_misuse', verdict: 'flagged' });
    h.store.insert({ session_id: 1, classifier_name: 'completeness', verdict: 'flagged' });
    h.store.insert({ session_id: 1, classifier_name: 'tool_misuse', verdict: 'flagged' });
    const rows = h.store.findRecentBySession(1, { classifierName: 'tool_misuse' });
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.classifier_name === 'tool_misuse')).toBe(true);
  });

  it('respects the limit option', () => {
    for (let i = 0; i < 10; i++) {
      h.store.insert({ session_id: 1, classifier_name: 'off_topic', verdict: 'ok' });
    }
    expect(h.store.findRecentBySession(1, { limit: 3 }).length).toBe(3);
    expect(h.store.findRecentBySession(1).length).toBe(10);
  });

  it('respects sinceMs (filters rows older than cutoff)', () => {
    // Insert a row "in the past" by directly tweaking created_at after insertion.
    const id = h.store.insert({ session_id: 1, classifier_name: 'off_topic', verdict: 'ok' });
    h.db.raw().prepare(
      `UPDATE quality_classifications SET created_at = ? WHERE id = ?`,
    ).run('2020-01-01 00:00:00', id);
    // A second row, fresh.
    h.store.insert({ session_id: 1, classifier_name: 'completeness', verdict: 'warn' });

    const all = h.store.findRecentBySession(1);
    expect(all.length).toBe(2);

    const recent = h.store.findRecentBySession(1, { sinceMs: 60_000 });
    expect(recent.length).toBe(1);
    expect(recent[0].classifier_name).toBe('completeness');
  });
});

describe('clearAll', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('drops every row regardless of age', () => {
    h.store.insert({ session_id: 1, classifier_name: 'off_topic', verdict: 'ok' });
    h.store.insert({ session_id: 2, classifier_name: 'policy', verdict: 'flagged' });
    const deleted = h.store.clearAll();
    expect(deleted).toBe(2);
    expect(h.store.findRecentBySession(1)).toEqual([]);
    expect(h.store.findRecentBySession(2)).toEqual([]);
  });
});

describe('migration 234 compatibility', () => {
  it('keeps inserts and overview available when provider_requests is missing', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE quality_classifications (
        id INTEGER PRIMARY KEY,
        session_id INTEGER,
        company_session_id INTEGER,
        agent_run_id INTEGER,
        coder_run_id TEXT,
        parent_run_id TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        subagent_profile TEXT,
        message_id TEXT,
        assessment_id TEXT,
        round_message_id INTEGER,
        scope TEXT NOT NULL DEFAULT 'legacy_turn',
        source TEXT NOT NULL DEFAULT 'legacy_llm',
        action_taken TEXT NOT NULL DEFAULT 'none',
        evidence_json TEXT,
        classifier_name TEXT NOT NULL,
        verdict TEXT NOT NULL,
        system_error INTEGER NOT NULL DEFAULT 0,
        confidence REAL,
        reason TEXT,
        provider_id TEXT,
        model_id TEXT,
        latency_ms REAL,
        cost_usd REAL,
        tokens_in INTEGER,
        tokens_out INTEGER,
        raw_response_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const store = new QualityClassificationStore(db);

    expect(() => store.insert({
      assessment_id: 'assessment-1',
      round_message_id: 41,
      scope: 'run_final',
      source: 'terminal_llm',
      classifier_name: 'delivery_overall',
      verdict: 'ok',
      tokens_in: 12,
      tokens_out: 3,
      provider_requests: 1,
    })).not.toThrow();
    expect(store.overview()).toMatchObject({
      completedTasks: 1,
      assessments: 1,
      llmRequests: 0,
      tokensIn: 12,
      tokensOut: 3,
    });
    db.close();
  });
});

describe('system_error (mig 202)', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('persists the flag and defaults to 0', () => {
    h.store.insert({ session_id: 1, classifier_name: 'code_quality', verdict: 'error', system_error: true });
    h.store.insert({ session_id: 1, classifier_name: 'code_quality', verdict: 'error' });
    const rows = h.store.findRecentBySession(1);
    expect(rows.map((r) => r.system_error).sort()).toEqual([0, 1]);
  });

  it('verdictDistribution excludes infra failures on demand', () => {
    h.store.insert({ classifier_name: 'tool_misuse', verdict: 'error', system_error: true });
    h.store.insert({ classifier_name: 'tool_misuse', verdict: 'error' }); // content judgment
    h.store.insert({ classifier_name: 'tool_misuse', verdict: 'ok' });

    const raw = h.store.verdictDistribution({ classifierName: 'tool_misuse' });
    expect(raw.find((d) => d.verdict === 'error')?.count).toBe(2);

    const clean = h.store.verdictDistribution({ classifierName: 'tool_misuse', excludeSystemErrors: true });
    expect(clean.find((d) => d.verdict === 'error')?.count).toBe(1);
    expect(clean.find((d) => d.verdict === 'ok')?.count).toBe(1);
  });

  it('countSystemErrors counts only infra failures', () => {
    h.store.insert({ classifier_name: 'policy', verdict: 'error', system_error: true });
    h.store.insert({ classifier_name: 'policy', verdict: 'error', system_error: true });
    h.store.insert({ classifier_name: 'policy', verdict: 'error' });
    expect(h.store.countSystemErrors()).toBe(2);
  });
});

describe('findRecentByAgentRunIds', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns empty when the input list is empty', () => {
    expect(h.store.findRecentByAgentRunIds([])).toEqual([]);
  });

  it('returns rows for any of the given run ids', () => {
    h.store.insert({ agent_run_id: 10, classifier_name: 'completeness', verdict: 'flagged' });
    h.store.insert({ agent_run_id: 11, classifier_name: 'off_topic',    verdict: 'warn'    });
    h.store.insert({ agent_run_id: 99, classifier_name: 'off_topic',    verdict: 'ok'      });
    const rows = h.store.findRecentByAgentRunIds([10, 11]);
    expect(rows.length).toBe(2);
    expect(rows.every((r) => r.agent_run_id === 10 || r.agent_run_id === 11)).toBe(true);
  });

  it('ignores non-finite ids (defensive)', () => {
    h.store.insert({ agent_run_id: 10, classifier_name: 'completeness', verdict: 'flagged' });
    const rows = h.store.findRecentByAgentRunIds([10, Number.NaN as never, Infinity as never]);
    expect(rows.length).toBe(1);
  });

  it('respects sinceMs', () => {
    const id1 = h.store.insert({ agent_run_id: 10, classifier_name: 'completeness', verdict: 'flagged' });
    h.db.raw().prepare(`UPDATE quality_classifications SET created_at = ? WHERE id = ?`).run('2020-01-01 00:00:00', id1);
    h.store.insert({ agent_run_id: 10, classifier_name: 'tool_misuse', verdict: 'warn' });

    const recent = h.store.findRecentByAgentRunIds([10], { sinceMs: 60_000 });
    expect(recent.length).toBe(1);
    expect(recent[0].classifier_name).toBe('tool_misuse');
  });
});
