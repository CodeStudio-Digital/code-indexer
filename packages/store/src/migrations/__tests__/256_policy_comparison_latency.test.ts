import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { policyEngine255 } from '../255_policy_engine.js';
import { policyComparisonLatency256 } from '../256_policy_comparison_latency.js';
import { PolicyDecisionStore } from '../../control-plane/policy-decision-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;

function evaluationColumns(): string[] {
  return (db.prepare('PRAGMA table_info(policy_decision_comparisons)').all() as Array<{ name: string }>)
    .map((row) => row.name)
    .filter((name) => name === 'evaluation_ms');
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  policyEngine255.up(db);
});

afterEach(() => db.close());

describe('migration 256 - policy comparison latency', () => {
  it('adds evaluation_ms exactly once even when applied twice', () => {
    policyComparisonLatency256.up(db);
    policyComparisonLatency256.up(db);
    expect(evaluationColumns()).toEqual(['evaluation_ms']);
  });

  it('persists and hydrates evaluationMs through the store', () => {
    policyComparisonLatency256.up(db);
    const store = new PolicyDecisionStore(db);
    store.record({
      decision: {
        decisionId: 'decision:1',
        effect: 'allow',
        reasonCode: 'default_allow',
        explanation: 'ok',
        precedence: 8,
        sources: [],
        constraints: [],
        requiresReevaluation: false,
        audit: {
          capabilityId: 'cap:1' as never,
          capabilityVersion: '1',
          policyVersion: 'v1',
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      capabilityId: 'cap:1',
      capabilityVersion: '1',
      policyVersion: 'v1',
      background: false,
    });

    const recorded = store.recordComparison({
      comparisonId: 'cmp:1',
      decisionId: 'decision:1',
      capabilityId: 'cap:1',
      legacyEffect: 'allow',
      shadowEffect: 'allow',
      evaluationMs: 4.25,
    });
    expect(recorded.evaluationMs).toBe(4.25);

    const listed = store.listComparisons(10);
    expect(listed).toHaveLength(1);
    expect(listed[0].evaluationMs).toBe(4.25);
  });

  it('keeps evaluationMs optional (older callers persist null)', () => {
    policyComparisonLatency256.up(db);
    const store = new PolicyDecisionStore(db);
    store.record({
      decision: {
        decisionId: 'decision:2',
        effect: 'deny',
        reasonCode: 'plan_mode',
        explanation: 'blocked',
        precedence: 3,
        sources: [],
        constraints: [],
        requiresReevaluation: false,
        audit: {
          capabilityId: 'cap:2' as never,
          capabilityVersion: '1',
          policyVersion: 'v1',
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      capabilityId: 'cap:2',
      capabilityVersion: '1',
      policyVersion: 'v1',
      background: false,
    });
    store.recordComparison({
      comparisonId: 'cmp:2',
      decisionId: 'decision:2',
      capabilityId: 'cap:2',
      legacyEffect: 'block',
      shadowEffect: 'deny',
    });
    expect(store.listComparisons(10)[0].evaluationMs).toBeUndefined();
  });
});
