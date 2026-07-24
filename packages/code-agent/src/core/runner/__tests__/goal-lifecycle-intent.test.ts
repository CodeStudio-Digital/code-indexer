import { describe, expect, it } from 'vitest';
import {
  GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
  hasLegacyMissingGoalCompletionAttempt,
  markGoalLifecycleIntentCache,
  resolveGoalLifecycleAuthority,
  resolveGoalLifecycleIntent,
} from '../goal-lifecycle-intent.js';
import type { AgentMessage } from '@mcp/provider-sdk';

const MARKED_AT = '2026-07-23T12:00:00.000Z';

describe('resolveGoalLifecycleIntent', () => {
  it('recognizes the canonical persisted snake_case missing-goal result', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'goal-update-1',
          name: 'update_goal',
          input: { status: 'complete' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: 'goal-update-1',
          content: 'No goal set. Call create_goal first.',
          is_error: true,
        }],
      },
    ];

    expect(hasLegacyMissingGoalCompletionAttempt(messages)).toBe(true);
  });

  it('does not infer legacy lifecycle authority from unrelated or successful results', () => {
    const messages: AgentMessage[] = [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'other-tool',
          name: 'read_file',
          input: {},
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: 'other-tool',
          content: 'No goal set. Call create_goal first.',
          is_error: true,
        }],
      },
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'goal-update-success',
          name: 'update_goal',
          input: { status: 'complete' },
        }],
      },
      {
        role: 'tool',
        content: [{
          type: 'tool_result',
          tool_use_id: 'goal-update-success',
          content: 'No goal set. Call create_goal first.',
          is_error: false,
        }],
      },
    ];

    expect(hasLegacyMissingGoalCompletionAttempt(messages)).toBe(false);
  });

  it.each(['bugfix', ' feature ', 'REFACTOR', 'config', 'test'])(
    'requires a goal for a fresh actionable %s task',
    (freshTaskKind) => {
      expect(resolveGoalLifecycleIntent({
        hasHistory: false,
        freshTaskKind,
      })).toBe('required_fresh');
    },
  );

  it('requires a goal for a deterministic actionable turn when preflight is absent', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: false,
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.7,
      currentTurnMessage: 'corrija tudo',
    })).toBe('required_fresh');
  });

  it.each([undefined, 'explore', 'docs', 'other', 'unknown'])(
    'keeps a fresh %s task ledger-driven',
    (freshTaskKind) => {
      expect(resolveGoalLifecycleIntent({
        hasHistory: false,
        freshTaskKind,
      })).toBe('ledger');
    },
  );

  it('rehydrates an actionable kind from the current cache envelope', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: JSON.stringify({
        h: 'content-hash',
        goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
        seed: { taskKind: ' BugFix ', profile: 'full' },
      }),
      persistedGoalStatus: null,
    })).toBe('required_resume');
  });

  it('accepts a marked direct seed shape on resume', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: JSON.stringify({
        goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
        taskKind: 'FEATURE',
      }),
      persistedGoalStatus: null,
    })).toBe('required_resume');
  });

  it('ignores actionable envelopes written before lifecycle authority was versioned', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: JSON.stringify({
        h: 'legacy-content-hash',
        seed: { taskKind: 'bugfix' },
      }),
      persistedGoalStatus: null,
    })).toBe('ledger');
  });

  it('rehydrates an unmarked legacy cache only after a proven missing-goal completion attempt', () => {
    const cachedPreflightSeedJson = JSON.stringify({
      h: 'legacy-content-hash',
      seed: { taskKind: 'bugfix' },
    });
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson,
      persistedGoalStatus: null,
      legacyMissingGoalCompletionAttempt: true,
    })).toBe('required_resume');
  });

  it('treats a persisted in-progress goal as durable pending authority by itself', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: null,
      persistedGoalStatus: 'in_progress',
    })).toBe('required_resume');
  });

  it('stops reapplying cached intent after the persisted goal is complete', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: JSON.stringify({
        h: 'content-hash',
        goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
        seed: { taskKind: 'bugfix' },
      }),
      persistedGoalStatus: 'complete',
    })).toBe('ledger');
  });

  it('requires a fresh lifecycle for an actionable request after a completed goal', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'complete',
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.7,
      currentTurnMessage: 'fix the new export bug',
    })).toBe('required_fresh');
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'complete',
      currentTurnIntent: 'answer',
      currentTurnConfidence: 0.6,
      currentTurnMessage: 'why did that work?',
    })).toBe('ledger');
  });

  it('grants distinct pivot authority while an ordinary follow-up resumes', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'in_progress',
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.7,
      currentTurnMessage: 'continue fixing the remaining tests',
    })).toBe('required_resume');
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.7,
      currentTurnMessage: 'troque para a tarefa de adicionar exportação CSV',
    })).toBe('required_pivot');
  });

  it.each([
    'agora rode os testes',
    'também rode os testes',
    'also run the tests',
    'next run the tests',
  ])('does not mistake an additive or temporal continuation for a pivot: %s', (currentTurnMessage) => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnIntent: 'verify',
      currentTurnConfidence: 0.75,
      currentTurnMessage,
    })).toBe('required_resume');
  });

  it.each([
    'mude a cor do botão para azul',
    'troque o texto do título',
    'substitua a chave antiga do cache',
    'change the button color to blue',
    'replace the old cache key',
    'use the compact layout instead',
  ])('does not supersede the session goal for an in-scope edit: %s', (currentTurnMessage) => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.8,
      currentTurnMessage,
    })).toBe('required_resume');
  });

  it.each([
    'troque para a tarefa de exportação',
    'mude o objetivo para corrigir o login',
    'substitua esta tarefa pela correção do cache',
    'switch to the export task',
    'change the objective to login',
    'replace this task with the cache fix',
  ])('recognizes an explicit replacement verb as a pivot: %s', (currentTurnMessage) => {
    const authority = resolveGoalLifecycleAuthority({
      hasHistory: true,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.7,
      currentTurnMessage,
    });
    expect(authority).toEqual({
      intent: 'required_pivot',
      pivotGoalCreatedAt: '2026-07-23T11:00:00.000Z',
    });
  });

  it('treats a continuation directive after completion as a fresh objective generation', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      persistedGoalStatus: 'complete',
      currentTurnIntent: 'answer',
      currentTurnConfidence: 0.25,
      currentTurnMessage: 'Continue',
    })).toBe('required_fresh');
  });

  it('keeps a deterministic fresh objective pending across restart without preflight', () => {
    const freshIntent = resolveGoalLifecycleIntent({
      hasHistory: false,
      currentTurnIntent: 'edit',
      currentTurnConfidence: 0.7,
      currentTurnMessage: 'corrija tudo',
    });
    expect(freshIntent).toBe('required_fresh');

    const cache = markGoalLifecycleIntentCache(null, undefined, {
      required: true,
      now: MARKED_AT,
    });
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: null,
      persistedGoalCreatedAt: null,
      currentTurnMessage: '',
    })).toBe('required_fresh');
  });

  it('keeps a new objective pending after an old goal completes until a new goal is created', () => {
    const cache = markGoalLifecycleIntentCache(null, undefined, {
      required: true,
      now: MARKED_AT,
    });
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: 'complete',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnMessage: '',
    })).toBe('required_fresh');

    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T12:00:00.000Z',
      currentTurnMessage: '',
    })).toBe('required_resume');
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: 'complete',
      persistedGoalCreatedAt: '2026-07-23T12:00:00.000Z',
      currentTurnMessage: '',
    })).toBe('ledger');
  });

  it('keeps explicit pivot authority durable across crash before and after superseding', () => {
    const cache = markGoalLifecycleIntentCache(null, undefined, {
      required: true,
      pivotGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      now: MARKED_AT,
    });
    expect(resolveGoalLifecycleAuthority({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnMessage: '',
    })).toEqual({
      intent: 'required_pivot',
      pivotGoalCreatedAt: '2026-07-23T11:00:00.000Z',
    });

    expect(resolveGoalLifecycleAuthority({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: 'superseded',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnMessage: '',
    })).toEqual({
      intent: 'required_pivot',
      pivotGoalCreatedAt: '2026-07-23T11:00:00.000Z',
    });

    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: cache,
      persistedGoalStatus: 'in_progress',
      persistedGoalCreatedAt: '2026-07-23T12:00:00.000Z',
      currentTurnMessage: '',
    })).toBe('required_resume');
  });

  it('requires the replacement after a crash even if the pending cache write was lost', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: null,
      persistedGoalStatus: 'superseded',
      persistedGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      currentTurnMessage: '',
    })).toBe('required_fresh');
  });

  it('marks a current cache envelope without losing its hash or seed', () => {
    const marked = markGoalLifecycleIntentCache(JSON.stringify({
      h: 'content-hash',
      seed: { taskKind: 'bugfix', profile: 'navigate' },
    }), 'bugfix', { now: MARKED_AT });

    expect(JSON.parse(marked)).toEqual({
      h: 'content-hash',
      seed: { taskKind: 'bugfix', profile: 'navigate' },
      goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
      goalLifecycleRequired: true,
      goalLifecyclePendingSince: MARKED_AT,
    });
  });

  it('overrides a missing or stale cached kind with the fresh validated authority', () => {
    for (const seed of [
      { profile: 'navigate' },
      { taskKind: 'explore', profile: 'navigate' },
    ]) {
      const marked = markGoalLifecycleIntentCache(JSON.stringify({
        h: 'content-hash',
        seed,
      }), ' BugFix ', { now: MARKED_AT });
      expect(JSON.parse(marked)).toEqual({
        h: 'content-hash',
        seed: { ...seed, taskKind: 'bugfix' },
        goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
        goalLifecycleRequired: true,
        goalLifecyclePendingSince: MARKED_AT,
      });
    }
  });

  it('creates a minimal marked envelope for a missing or corrupt cache', () => {
    for (const raw of [null, '{broken']) {
      expect(JSON.parse(markGoalLifecycleIntentCache(raw, ' BugFix ', { now: MARKED_AT }))).toEqual({
        goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
        seed: { taskKind: 'bugfix' },
        goalLifecycleRequired: true,
        goalLifecyclePendingSince: MARKED_AT,
      });
    }
  });

  it('clears the explicit pending marker without discarding cached preflight data', () => {
    const pending = markGoalLifecycleIntentCache(JSON.stringify({
      h: 'content-hash',
      seed: { taskKind: 'bugfix', profile: 'navigate' },
    }), 'bugfix', { required: true, now: MARKED_AT });
    const cleared = markGoalLifecycleIntentCache(
      pending,
      undefined,
      { required: false, now: '2026-07-23T12:01:00.000Z' },
    );

    expect(JSON.parse(cleared)).toEqual({
      h: 'content-hash',
      seed: { taskKind: 'bugfix', profile: 'navigate' },
      goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
      goalLifecycleRequired: false,
    });
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson: cleared,
      persistedGoalStatus: null,
      currentTurnMessage: '',
    })).toBe('ledger');
  });

  it('clears durable pivot authority when the replacement goal is created', () => {
    const pending = markGoalLifecycleIntentCache(null, undefined, {
      required: true,
      pivotGoalCreatedAt: '2026-07-23T11:00:00.000Z',
      now: MARKED_AT,
    });
    expect(JSON.parse(pending)).toMatchObject({
      goalLifecycleRequired: true,
      goalLifecyclePivotGoalCreatedAt: '2026-07-23T11:00:00.000Z',
    });

    const cleared = markGoalLifecycleIntentCache(pending, undefined, {
      required: false,
      now: '2026-07-23T12:01:00.000Z',
    });
    expect(JSON.parse(cleared)).toEqual({
      goalLifecycleIntentVersion: GOAL_LIFECYCLE_INTENT_CACHE_VERSION,
      seed: {},
      goalLifecycleRequired: false,
    });
  });

  it.each([
    '{broken',
    JSON.stringify({ h: 'content-hash', seed: { taskKind: 'explore' } }),
    JSON.stringify({ h: 'content-hash', seed: null }),
  ])('fails open to ledger gating for unusable cached input', (cachedPreflightSeedJson) => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: true,
      cachedPreflightSeedJson,
      persistedGoalStatus: null,
    })).toBe('ledger');
  });

  it('never applies a stale cached kind to a fresh run', () => {
    expect(resolveGoalLifecycleIntent({
      hasHistory: false,
      freshTaskKind: 'explore',
      cachedPreflightSeedJson: JSON.stringify({ seed: { taskKind: 'bugfix' } }),
      persistedGoalStatus: null,
    })).toBe('ledger');
  });
});
