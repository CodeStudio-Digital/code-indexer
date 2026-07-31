import { describe, expect, it } from 'vitest';
import { planQuery } from '../planner.js';

describe('semantic search planner', () => {
  it('routes conceptual keyword bags to hybrid retrieval', () => {
    expect(planQuery('session expiration token timeout')).toEqual({
      mode: 'hybrid',
      reason: 'concept keyword query',
    });
    expect(planQuery('login lockout failed attempts configuration').mode).toBe('hybrid');
  });

  it('keeps real code identifiers and paths on FTS', () => {
    expect(planQuery('parseIdParam parseJsonBody').mode).toBe('fts');
    expect(planQuery('src/auth/session-policy.js expiresAt').mode).toBe('fts');
    expect(planQuery('MAX_FAILED_ATTEMPTS canAttemptLogin').mode).toBe('fts');
  });

  it('keeps one or two plain lookup terms cheap', () => {
    expect(planQuery('auth middleware')).toEqual({
      mode: 'fts',
      reason: 'short mixed query',
    });
  });
});
