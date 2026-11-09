import { describe, expect, it } from 'vitest';
import { lexicalQuery, planQuery } from '../planner.js';

describe('semantic search planner', () => {
  it('removes prose stopwords without erasing literal lookups', () => {
    expect(lexicalQuery('Where is the session expiration policy?')).toBe('session expiration policy?');
    expect(lexicalQuery('Onde a sessão do usuário é validada?')).toBe('sessão usuário validada?');
    expect(lexicalQuery('a')).toBe('a');
    expect(lexicalQuery('auth.api_client')).toBe('auth.api_client');
  });
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
