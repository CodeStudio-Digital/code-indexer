import { describe, expect, it } from 'vitest';
import { BatchTracker, validateBatch } from '../batch-outcome.js';

describe('batch evidence', () => {
  it('never reports rollback after an uncertain commit, even if rollback replies', () => {
    const t = new BatchTracker('transactional', {});
    expect(t.failure(new Error('pool'), false).outcome.effect).toBe('not_started');
    t.started = true;
    expect(t.failure(new Error('statement'), true).outcome.effect).toBe('rolled_back');
    expect(t.failure(new Error('connection'), false).outcome.effect).toBe('unknown');
    t.committing = true;
    expect(t.failure(new Error('lost commit ack'), true).outcome.effect).toBe('unknown');
  });
  it('does not promise atomic rollback for engines with implicit commits', () => {
    const t = new BatchTracker('best_effort', {});
    t.started = true;
    t.completed = 1;
    expect(t.failure(new Error('statement 2'), true).outcome).toMatchObject({ effect: 'partial', failedStatement: 2 });
  });
  it('rejects transaction escapes and read-only violations before dispatch', () => {
    for (const sql of ['COMMIT', 'SELECT 1; DELETE FROM a', "SELECT '--'; DELETE FROM a"]) {
      expect(() => validateBatch([sql])).toThrow();
    }
    expect(() => validateBatch(['DELETE FROM a'], true)).toThrow();
    expect(() => validateBatch(['SELECT 1', 'SELECT 2'], true)).not.toThrow();
  });
});
