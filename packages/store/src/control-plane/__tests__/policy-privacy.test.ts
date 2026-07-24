import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { policyEngine255 } from '../../migrations/255_policy_engine.js';
import { policyComparisonLatency256 } from '../../migrations/256_policy_comparison_latency.js';
import { PolicyDecisionStore } from '../policy-decision-store.js';
import { PolicyGrantStore } from '../policy-grant-store.js';
import { CapabilityStore } from '../capability-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;

// Raw values that must NEVER be persisted verbatim into the Fase 2 tables.
const SECRETS = [
  'SECRET-EFFECTIVE-INPUT',
  'SECRET-USER-ARGUMENT',
  'SECRET-TOKEN-VALUE',
];

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let db: DB;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  policyEngine255.up(db);
  policyComparisonLatency256.up(db);
});

afterEach(() => db.close());

function dumpTable(table: string): string {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => JSON.stringify(r)).join('\n');
}

describe('policy engine privacy', () => {
  it('never persists raw effective input / arguments / secrets in policy tables', () => {
    const effectiveInputHash = sha256Hex(JSON.stringify({
      path: 'src/a.ts',
      token: 'SECRET-EFFECTIVE-INPUT',
      note: 'SECRET-USER-ARGUMENT',
    }));

    const decisions = new PolicyDecisionStore(db);
    decisions.record({
      decision: {
        decisionId: 'decision:1',
        effect: 'allow',
        reasonCode: 'default_allow',
        explanation: 'ok',
        precedence: 8,
        sources: [{ sourceType: 'system', sourceRef: 'core/policy.ts', outcome: 'abstain' }],
        // Constraints legitimately carry the canonical resource (a path), which
        // is metadata, not raw content — no secret is placed here.
        constraints: [{ kind: 'path', root: '/repo/src/a.ts', access: 'write', followSymlinks: false }],
        requiresReevaluation: false,
        audit: {
          capabilityId: 'cap:native:edit_file' as never,
          capabilityVersion: '1',
          policyVersion: 'v1',
          decidedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      capabilityId: 'cap:native:edit_file',
      capabilityVersion: '1',
      effectiveInputHash,
      policyVersion: 'v1',
      background: false,
    });

    const comparison = decisions.recordComparison({
      comparisonId: 'cmp:1',
      decisionId: 'decision:1',
      capabilityId: 'cap:native:edit_file',
      legacyEffect: 'allow',
      shadowEffect: 'allow',
    });
    expect(comparison.agreement).toBe(true);

    const grants = new PolicyGrantStore(db);
    grants.issue({
      grantId: 'grant:1',
      subject: { actorId: 'local-user' },
      capabilities: [{ capabilityId: 'cap:native:edit_file' as never, capabilityVersion: '1' }],
      constraints: [{ kind: 'secret', secretIds: ['secret-ref-1'], exposure: 'handle-only' }],
      duration: 'once',
      // The binding carries ONLY the hash, never the raw token.
      binding: { decisionId: 'decision:1', effectiveInputHash, nonce: 'nonce-1' },
      effectiveInputHash,
      policyVersion: 'v1',
      nonce: 'nonce-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });

    const capabilities = new CapabilityStore(db);
    capabilities.recordDescriptor({
      capabilityId: 'cap:native:edit_file' as never,
      version: '1',
      name: 'edit_file',
      aliases: [],
      displayName: 'edit_file',
      description: 'edits a file',
      source: { kind: 'native', providerId: 'coder-native', metadataTrust: 'local' },
      inputSchema: { type: 'object' },
      visibility: { defaultTier: 'navigate', searchable: true, promptSummaryClass: 'discoverable' },
      execution: {
        class: 'write', mutates: true, parallelSafe: false, repeatPolicy: 'mutating',
        sideEffect: { kind: 'local', idempotency: 'none', safeRetryStages: [], ambiguousOutcome: 'mark_outcome_unknown' },
        timeoutPolicy: 'default', cancellation: 'cooperative',
      },
      requirements: { sandboxRequired: false, interactive: false },
      riskClassifierRef: 'risk:write',
      outputPolicyRef: 'output:default',
      enabled: true,
    }, '1');

    const dump = [
      dumpTable('policy_decisions'),
      dumpTable('policy_decision_comparisons'),
      dumpTable('policy_grants'),
      dumpTable('capability_descriptors'),
    ].join('\n');

    for (const secret of SECRETS) {
      expect(dump, `policy tables leaked ${secret}`).not.toContain(secret);
    }
    // Positive control: the opaque hash and canonical refs ARE persisted.
    expect(dump).toContain(effectiveInputHash);
    expect(dump).toContain('secret-ref-1'); // reference id, not the secret value
    expect(dump).toContain('cap:native:edit_file');
  });
});
