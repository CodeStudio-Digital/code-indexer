import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type DatabaseConstructor from 'better-sqlite3';
import { policyEngine255 } from '../../migrations/255_policy_engine.js';
import { PolicyGrantStore, type PolicyGrantSeed } from '../policy-grant-store.js';

type DB = InstanceType<typeof DatabaseConstructor>;
let db: DB;
let store: PolicyGrantStore;

const FUTURE = '2099-01-01T00:00:00.000Z';
const PAST = '2000-01-01T00:00:00.000Z';

function onceSeed(overrides: Partial<PolicyGrantSeed> = {}): PolicyGrantSeed {
  return {
    grantId: 'grant:1',
    subject: { actorId: 'local-user' },
    capabilities: [{ capabilityId: 'cap:1' as never, capabilityVersion: '1' }],
    constraints: [{ kind: 'path', root: '/repo', access: 'write', followSymlinks: false }],
    duration: 'once',
    binding: { decisionId: 'dec:1', nonce: 'nonce-1' },
    effectiveInputHash: 'hash-1',
    policyVersion: 'v1',
    nonce: 'nonce-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: FUTURE,
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec('CREATE TABLE coder_sessions (id INTEGER PRIMARY KEY)');
  policyEngine255.up(db);
  store = new PolicyGrantStore(db);
});

afterEach(() => db.close());

describe('PolicyGrantStore once-grant CAS', () => {
  it('issues and consumes a once grant exactly one time', () => {
    store.issue(onceSeed());
    const first = store.consumeOnce('grant:1', 'nonce-1', 'tu-1');
    const second = store.consumeOnce('grant:1', 'nonce-1', 'tu-2');
    expect(first.kind).toBe('consumed');
    expect(second.kind).toBe('already_consumed');
    expect(store.get('grant:1')).toMatchObject({
      consumptionStatus: 'consumed',
      consumedByToolUseId: 'tu-1',
    });
  });

  it('rejects consumption with a mismatched nonce (binding changed)', () => {
    store.issue(onceSeed());
    const result = store.consumeOnce('grant:1', 'nonce-STALE', 'tu-1');
    expect(result.kind).toBe('already_consumed');
    expect(store.get('grant:1')?.consumptionStatus).toBe('unconsumed');
  });

  it('refuses an expired grant before the CAS', () => {
    store.issue(onceSeed({ grantId: 'grant:exp', nonce: 'nonce-exp', expiresAt: PAST }));
    const result = store.consumeOnce('grant:exp', 'nonce-exp', 'tu-1', '2026-06-01T00:00:00.000Z');
    expect(result.kind).toBe('expired');
  });

  it('refuses a revoked grant and cannot revoke an already-consumed one', () => {
    store.issue(onceSeed({ grantId: 'grant:rev', nonce: 'nonce-rev' }));
    expect(store.revoke('grant:rev')).toBe(true);
    expect(store.consumeOnce('grant:rev', 'nonce-rev', 'tu-1').kind).toBe('revoked');

    store.issue(onceSeed({ grantId: 'grant:done', nonce: 'nonce-done' }));
    store.consumeOnce('grant:done', 'nonce-done', 'tu-1');
    expect(store.revoke('grant:done')).toBe(false);
  });

  it('returns not_found for an unknown grant', () => {
    expect(store.consumeOnce('grant:ghost', 'nonce-x', 'tu-1').kind).toBe('not_found');
  });
});
