import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import * as prompts from '../master-prompts.js';
import { masterPrompts032 } from '../../migrations/032_master_prompts.js';
import { masterPromptDeliveryAuthority260 } from '../../migrations/260_master_prompt_delivery_authority.js';

describe('master prompt durable delivery authority', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE company_sessions (id INTEGER PRIMARY KEY)`);
    masterPrompts032.up(db);
    masterPromptDeliveryAuthority260.up(db);
    db.exec(`INSERT INTO company_sessions (id) VALUES (1)`);
  });

  function createQuestion() {
    return prompts.create(db, {
      company_session_id: 1,
      agent_run_id: null,
      kind: 'question',
      body: 'why?',
    });
  }

  it('survives an uncertain attempt and never implicitly redelivers it', () => {
    const prompt = createQuestion();

    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-1', 'hash-1'))
      .toMatchObject({ kind: 'claimed', token: 'token-1' });
    expect(prompts.markDeliveryOutcomeUnknown(db, prompt.id, 'token-1')).toBe(true);

    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-2', 'hash-1'))
      .toMatchObject({ kind: 'outcome_unknown' });
    expect(prompts.claimDelivery(
      db,
      prompt.id,
      1,
      'question',
      'token-3',
      'different-hash',
      { retryOutcomeUnknown: true },
    )).toMatchObject({ kind: 'payload_conflict' });

    expect(prompts.claimDelivery(
      db,
      prompt.id,
      1,
      'question',
      'token-4',
      'hash-1',
      { retryOutcomeUnknown: true },
    )).toMatchObject({ kind: 'claimed', token: 'token-4' });
    expect(prompts.completeDelivery(
      db,
      prompt.id,
      'token-4',
      { kind: 'question', answer: 'because' },
    )).toMatchObject({ status: 'answered', answer: 'because' });
    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-5', 'hash-1'))
      .toMatchObject({ kind: 'not_pending' });
  });

  it('releases an authoritative pre-effect refusal back to pending', () => {
    const prompt = createQuestion();
    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-1', 'hash-1'))
      .toMatchObject({ kind: 'claimed' });
    expect(prompts.releaseDelivery(db, prompt.id, 'wrong-token')).toBe(false);
    expect(prompts.releaseDelivery(db, prompt.id, 'token-1')).toBe(true);
    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-2', 'hash-1'))
      .toMatchObject({ kind: 'claimed', token: 'token-2' });
  });

  it('fences a stranded delivering row until a conscious same-payload retry', () => {
    const prompt = createQuestion();
    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-1', 'hash-1'))
      .toMatchObject({ kind: 'claimed' });

    // Simulates a process disappearing before it can mark OUTCOME_UNKNOWN.
    expect(prompts.claimDelivery(db, prompt.id, 1, 'question', 'token-2', 'hash-1'))
      .toMatchObject({ kind: 'delivery_in_progress' });
    expect(prompts.claimDelivery(
      db,
      prompt.id,
      1,
      'question',
      'token-3',
      'different-hash',
      { retryOutcomeUnknown: true },
    )).toMatchObject({ kind: 'payload_conflict' });
    expect(prompts.claimDelivery(
      db,
      prompt.id,
      1,
      'question',
      'token-4',
      'hash-1',
      { retryOutcomeUnknown: true },
    )).toMatchObject({ kind: 'claimed', token: 'token-4' });
  });
});
