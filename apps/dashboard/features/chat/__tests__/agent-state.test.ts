import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_AGENT,
  hydratedSessionAgent,
  isAgentPreset,
  mergeSessionAgentData,
} from '../agent-state.js';
import type { CoderSession, SessionData } from '../types.js';

function session(id: string, patch: Partial<CoderSession> = {}): CoderSession {
  return {
    id,
    project_id: 1,
    title: `Session ${id}`,
    provider: 'test',
    model: 'test-model',
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

describe('session agent dashboard state', () => {
  it('accepts built-in and custom agents while rejecting malformed values', () => {
    expect(isAgentPreset('build')).toBe(true);
    expect(isAgentPreset('custom:12345678-abcd-4321-abcd-123456789abc')).toBe(true);
    expect(isAgentPreset('custom:no')).toBe(false);
    expect(isAgentPreset('wizard')).toBe(false);
  });

  it('recovers the persisted agent only for the selected session', () => {
    const row = session('session-a', { agent: 'build' });
    expect(hydratedSessionAgent(row, 'session-a')).toBe('build');
    expect(hydratedSessionAgent(row, 'session-b')).toBeNull();
    expect(hydratedSessionAgent(session('session-a'), 'session-a')).toBe(
      DEFAULT_SESSION_AGENT,
    );
  });

  it('merges optimistic and authoritative state only into the matching cache', () => {
    const current = data(session('session-a', { agent: 'explore' }));
    expect(mergeSessionAgentData(current, 'session-b', 'build')).toBe(current);

    const merged = mergeSessionAgentData(
      current,
      'session-a',
      'build',
      session('session-a', { title: 'Authoritative', agent: 'build' }),
    );
    expect(merged.session.title).toBe('Authoritative');
    expect(merged.session.agent).toBe('build');
  });
});
