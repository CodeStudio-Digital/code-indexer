import { describe, expect, it } from 'vitest';
import { resolveReasoningLevels } from '../composer/provider-caps.js';
import {
  DEFAULT_NEW_EXECUTION_MODE,
  createSerializedAsyncQueue,
  executionModeChangeLocked,
  hydratedExecutionMode,
  hydratedReasoningEffort,
  mergeExecutionModeSessionData,
  modelCanReason,
  ultraManagesThinking,
} from '../execution-mode-state.js';
import type { CoderSession, ProviderOption, SessionData } from '../types.js';

function session(id: number, patch: Partial<CoderSession> = {}): CoderSession {
  return {
    id,
    project_id: 1,
    title: `Session ${id}`,
    provider: 'test',
    model: 'reasoner',
    status: 'idle',
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_cache_creation_tokens: 0,
    last_turn_input_tokens: 0,
    group_id: null,
    is_archived: false,
    archived_at: null,
    is_favorite: false,
    favorited_at: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
    ...patch,
  };
}

function data(row: CoderSession): SessionData {
  return { session: row, messages: [], message_rows: [] };
}

const providers: ProviderOption[] = [{
  id: 'test',
  label: 'Test',
  models: [
    {
      id: 'reasoner',
      name: 'Reasoner',
      mode: null,
      supported_reasoning_levels: [' low ', 'Ultra', 'HIGH', 'high', '', ' ultra '],
    },
    { id: 'fixed', name: 'Fixed', mode: null, can_reason: true },
    { id: 'legacy-only', name: 'Legacy only', mode: null, supported_reasoning_levels: [' ultra '] },
    { id: 'variant', name: 'Variant normal', mode: null, can_reason: false },
    { id: 'variant', name: 'Variant deep', mode: 'deep', can_reason: true },
  ],
}];

describe('execution-mode dashboard state', () => {
  it('defaults every new session class, including global sessions, to Standard', () => {
    expect(DEFAULT_NEW_EXECUTION_MODE).toBe('standard');
  });

  it('serializes execution-mode writes and lets send wait for the acknowledged tail', async () => {
    const queue = createSerializedAsyncQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = queue.enqueue(async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    const second = queue.enqueue(async () => { events.push('second'); });
    const sendGate = queue.wait().then(() => { events.push('send'); });

    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second, sendGate]);
    expect(events).toEqual(['first:start', 'first:end', 'second', 'send']);
  });

  it('derives legacy Ultra but never hydrates a stale session payload', () => {
    const legacy = session(7, {
      execution_mode_override: 'standard',
      reasoning_effort_override: '  ULTRA ',
    });
    expect(hydratedExecutionMode(legacy, 7)).toBe('ultra');
    expect(hydratedReasoningEffort(legacy, 7)).toBeNull();
    expect(hydratedExecutionMode(legacy, 8)).toBeNull();
    expect(hydratedReasoningEffort(legacy, 8)).toBeUndefined();
  });

  it('filters stale Ultra, blanks, and duplicate native reasoning levels', () => {
    expect(resolveReasoningLevels('test', providers, 'reasoner')).toEqual(['low', 'HIGH']);
    expect(resolveReasoningLevels('test', providers, 'missing')).toEqual([]);
  });

  it('derives can-reason without treating an Ultra-only stale catalog as native support', () => {
    expect(modelCanReason('test', providers, 'reasoner')).toBe(true);
    expect(modelCanReason('test', providers, 'fixed')).toBe(true);
    expect(modelCanReason('test', providers, 'legacy-only')).toBe(false);
    expect(modelCanReason('test', providers, 'variant')).toBe(false);
    expect(modelCanReason('test', providers, 'variant::deep')).toBe(true);
    expect(modelCanReason('test', providers, 'variant::missing')).toBe(false);
    expect(ultraManagesThinking('ultra', true)).toBe(true);
    expect(ultraManagesThinking('standard', true)).toBe(false);
  });

  it('locks changes for both attached streaming and detached/suspended running sessions', () => {
    expect(executionModeChangeLocked(true, 'idle')).toBe(true);
    expect(executionModeChangeLocked(false, 'running')).toBe(true);
    expect(executionModeChangeLocked(false, 'idle')).toBe(false);
    expect(executionModeChangeLocked(false, 'running', 4, 5)).toBe(false);
  });

  it('merges server state only into the matching session cache and clears legacy effort', () => {
    const current = data(session(4, { reasoning_effort_override: 'ultra' }));
    const stale = mergeExecutionModeSessionData(current, 5, 'ultra');
    expect(stale).toBe(current);

    const merged = mergeExecutionModeSessionData(
      current,
      4,
      'ultra',
      session(4, { title: 'Server title', reasoning_effort_override: null }),
    );
    expect(merged.session.title).toBe('Server title');
    expect(merged.session.execution_mode_override).toBe('ultra');
    expect(merged.session.reasoning_effort_override).toBeNull();
  });
});
