import { describe, expect, it } from 'vitest';
import {
  providerSupportsThinking,
  resolveReasoningLevels,
} from '../composer/provider-caps.js';
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

function session(id: string, patch: Partial<CoderSession> = {}): CoderSession {
  return {
    id,
    project_id: 1,
    title: `Session ${id.slice(0, 8)}`,
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

const SESSION_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ab';
const LEGACY_SESSION_ID = '018f0f5e-7b2d-7a45-8c11-0123456789ac';

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
    const legacy = session(LEGACY_SESSION_ID, {
      execution_mode_override: 'standard',
      reasoning_effort_override: '  ULTRA ',
    });
    expect(hydratedExecutionMode(legacy, LEGACY_SESSION_ID)).toBe('ultra');
    expect(hydratedReasoningEffort(legacy, LEGACY_SESSION_ID)).toBeNull();
    expect(hydratedExecutionMode(legacy, SESSION_ID)).toBeNull();
    expect(hydratedReasoningEffort(legacy, SESSION_ID)).toBeUndefined();
  });

  it('filters stale Ultra, blanks, and duplicate native reasoning levels', () => {
    expect(resolveReasoningLevels('test', providers, 'reasoner')).toEqual(['low', 'HIGH']);
    expect(resolveReasoningLevels('test', providers, 'missing')).toEqual([]);
  });

  it('uses Fugu native effort levels without showing the legacy thinking toggle', () => {
    const fuguProviders: ProviderOption[] = [{
      id: 'sakana',
      kind: 'fugu',
      label: 'Sakana AI Fugu',
      capabilities: { supportsThinking: false, supportsVision: true },
      models: [{
        id: 'fugu-ultra-v1.1',
        name: 'Fugu Ultra v1.1',
        mode: null,
        supported_reasoning_levels: ['high', 'xhigh', 'max'],
      }],
    }];

    expect(providerSupportsThinking('sakana', fuguProviders, 'fugu-ultra-v1.1')).toBe(false);
    expect(resolveReasoningLevels('sakana', fuguProviders, 'fugu-ultra-v1.1'))
      .toEqual(['high', 'xhigh', 'max']);
  });

  it.each(['glm-5.3', 'glm-5.4'])('uses the effort selector for %s Coding Plan and keeps the toggle for earlier GLM', (modelId: string) => {
    const catalog: ProviderOption[] = [{
      id: 'my-coding-plan', kind: 'zai', label: 'Z.AI Coding Plan',
      capabilities: { supportsThinking: true },
      models: [
        { id: modelId, name: modelId.toUpperCase(), mode: 'coding', can_reason: true,
          supported_reasoning_levels: ['low', 'high', 'max'] },
        { id: 'glm-5.1', name: 'GLM-5.1', mode: null },
      ],
    }];

    const selectedModel = `${modelId}::coding`;
    expect(resolveReasoningLevels('my-coding-plan', catalog, selectedModel)).toEqual(['low', 'high', 'max']);
    expect(providerSupportsThinking('my-coding-plan', catalog, selectedModel)).toBe(false);
    expect(providerSupportsThinking('my-coding-plan', catalog, 'glm-5.1')).toBe(true);
  });

  it('does not offer a fake Copilot thinking toggle for model-managed reasoning', () => {
    const copilotProviders: ProviderOption[] = [{
      id: 'copilot',
      kind: 'copilot',
      label: 'GitHub Copilot',
      capabilities: { supportsThinking: true, supportsVision: true },
      models: [
        {
          id: 'gemini-3.5-flash',
          name: 'Gemini 3.5 Flash',
          mode: null,
          can_reason: true,
          supported_reasoning_levels: null,
        },
        {
          id: 'gemini-3.6-flash',
          name: 'Gemini 3.6 Flash',
          mode: null,
          can_reason: true,
          supported_reasoning_levels: ['low', 'medium', 'high'],
        },
      ],
    }];

    expect(providerSupportsThinking('copilot', copilotProviders, 'gemini-3.5-flash')).toBe(false);
    expect(modelCanReason('copilot', copilotProviders, 'gemini-3.5-flash')).toBe(true);
    expect(providerSupportsThinking('copilot', copilotProviders, 'gemini-3.6-flash')).toBe(true);
  });

  it('derives can-reason without treating an Ultra-only stale catalog as native support', () => {
    expect(modelCanReason('test', providers, 'reasoner')).toBe(true);
    expect(modelCanReason('test', providers, 'fixed')).toBe(true);
    expect(modelCanReason('test', providers, 'legacy-only')).toBe(false);
    expect(modelCanReason('test', providers, 'variant')).toBe(false);
    expect(modelCanReason('test', providers, 'variant::deep')).toBe(true);
    expect(modelCanReason('test', providers, 'variant::missing')).toBe(false);
    expect(ultraManagesThinking('ultra', true)).toBe(false);
    expect(ultraManagesThinking('standard', true)).toBe(false);
  });

  it('locks changes for both attached streaming and detached/suspended running sessions', () => {
    expect(executionModeChangeLocked(true, 'idle')).toBe(true);
    expect(executionModeChangeLocked(false, 'running')).toBe(true);
    expect(executionModeChangeLocked(false, 'idle')).toBe(false);
    expect(executionModeChangeLocked(
      false,
      'running',
      SESSION_ID,
      LEGACY_SESSION_ID,
    )).toBe(false);
  });

  it('merges server state only into the matching session cache and clears legacy effort', () => {
    const current = data(session(SESSION_ID, { reasoning_effort_override: 'ultra' }));
    const stale = mergeExecutionModeSessionData(current, LEGACY_SESSION_ID, 'ultra');
    expect(stale).toBe(current);

    const merged = mergeExecutionModeSessionData(
      current,
      SESSION_ID,
      'ultra',
      session(SESSION_ID, { title: 'Server title', reasoning_effort_override: null }),
    );
    expect(merged.session.title).toBe('Server title');
    expect(merged.session.execution_mode_override).toBe('ultra');
    expect(merged.session.reasoning_effort_override).toBeNull();
  });
});
