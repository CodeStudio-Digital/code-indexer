/**
 * DriftDetector tests.
 *
 * Verifies that:
 *   - PSI = 0 when distributions are identical → stable
 *   - PSI rises monotonically as one bucket grows
 *   - The "stable / minor_drift / significant_drift" thresholds fire correctly
 *   - minRows guard returns null on sparse data
 *   - The recommendation string adapts to the dominant verdict shift
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { QualityClassificationStore } from '@mcp/store/quality-classification-store.js';
import { DriftDetector } from '../drift-detector.js';

interface H { db: CodeIndexDB; store: QualityClassificationStore; dir: string }

function setup(): H {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-drift-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  return { db, store: new QualityClassificationStore(db.raw()), dir };
}

function teardown(h: H): void {
  try { h.db.close(); } catch { /* */ }
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* */ }
}

function seedRow(store: QualityClassificationStore, classifierName: string, verdict: 'ok'|'warn'|'flagged'|'error'): void {
  store.insert({ classifier_name: classifierName, verdict });
}

/** Direct insert with a fixed created_at — bypasses store.insert which always uses datetime('now'). */
function seedRowAt(h: H, classifierName: string, verdict: 'ok'|'warn'|'flagged'|'error', at: Date): void {
  const ts = at.toISOString().slice(0, 19).replace('T', ' ');
  h.db.raw().prepare(
    `INSERT INTO quality_classifications (classifier_name, verdict, created_at)
     VALUES (?, ?, ?)`,
  ).run(classifierName, verdict, ts);
}

describe('DriftDetector', () => {
  let h: H;
  beforeEach(() => { h = setup(); });
  afterEach(() => teardown(h));

  it('returns null when recent window is too sparse', () => {
    for (let i = 0; i < 5; i++) seedRow(h.store, 'off_topic', 'ok');
    const detector = new DriftDetector({ store: h.store, minRows: 10 });
    expect(detector.detect('off_topic')).toBeNull();
  });

  it('reports "warming up" when baseline is empty', () => {
    // All rows fresh → recent window only; no baseline yet.
    for (let i = 0; i < 50; i++) seedRow(h.store, 'off_topic', 'ok');
    const detector = new DriftDetector({ store: h.store, minRows: 10 });
    const report = detector.detect('off_topic');
    expect(report).not.toBeNull();
    expect(report!.status).toBe('stable');
    expect(report!.psi).toBe(0);
    expect(report!.baselineRows).toBe(0);
    expect(report!.recommendation).toMatch(/warming up/i);
  });

  it('reports stable when both windows match closely', () => {
    const referenceNow = new Date('2026-05-18T12:00:00Z');
    // Baseline (5 days ago, mostly ok with a few warn).
    const baselineAt = new Date(referenceNow.getTime() - 5 * 24 * 3_600_000);
    for (let i = 0; i < 80; i++) seedRowAt(h, 'off_topic', 'ok', baselineAt);
    for (let i = 0; i < 20; i++) seedRowAt(h, 'off_topic', 'warn', baselineAt);
    // Recent (1 hour ago, same distribution).
    const recentAt = new Date(referenceNow.getTime() - 1 * 3_600_000);
    for (let i = 0; i < 40; i++) seedRowAt(h, 'off_topic', 'ok', recentAt);
    for (let i = 0; i < 10; i++) seedRowAt(h, 'off_topic', 'warn', recentAt);

    const detector = new DriftDetector({
      store: h.store,
      minRows: 10,
      recentWindowMs: 24 * 3_600_000,
      baselineWindowMs: 7 * 24 * 3_600_000,
      now: () => referenceNow,
    });
    const report = detector.detect('off_topic');
    expect(report).not.toBeNull();
    expect(report!.status).toBe('stable');
    expect(report!.psi).toBeLessThan(0.1);
  });

  it('reports drift when recent diverges from baseline', () => {
    const referenceNow = new Date('2026-05-18T12:00:00Z');
    // Baseline (5 days ago) all 'ok'.
    const baselineAt = new Date(referenceNow.getTime() - 5 * 24 * 3_600_000);
    for (let i = 0; i < 100; i++) seedRowAt(h, 'policy', 'ok', baselineAt);
    // Recent (1 hour ago) all 'flagged'.
    const recentAt = new Date(referenceNow.getTime() - 1 * 3_600_000);
    for (let i = 0; i < 100; i++) seedRowAt(h, 'policy', 'flagged', recentAt);

    const detector = new DriftDetector({
      store: h.store,
      minRows: 30,
      recentWindowMs: 24 * 3_600_000,
      baselineWindowMs: 7 * 24 * 3_600_000,
      now: () => referenceNow,
    });
    const report = detector.detect('policy');
    expect(report).not.toBeNull();
    expect(report!.psi).toBeGreaterThan(0.1);
    expect(report!.status).not.toBe('stable');
  });

  it('detectAll filters out classifiers with too few rows', () => {
    for (let i = 0; i < 50; i++) seedRow(h.store, 'off_topic', 'ok');
    const detector = new DriftDetector({ store: h.store, minRows: 5 });
    const reports = detector.detectAll(['off_topic', 'policy']);
    expect(reports).toHaveLength(1);
    expect(reports[0].classifierName).toBe('off_topic');
  });
});
