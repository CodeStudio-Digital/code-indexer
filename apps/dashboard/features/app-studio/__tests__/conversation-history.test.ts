import { describe, expect, it } from 'vitest';
import type { CoderSession } from '../../chat/types.js';
import { appStudioConversations } from '../conversation-history.js';

const session = (id: number, agent: CoderSession['agent']): CoderSession => ({
  id,
  project_id: 1,
  title: `Session ${id}`,
  provider: 'test',
  model: 'test',
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
  agent,
  created_at: '2026-07-14T00:00:00.000Z',
  updated_at: '2026-07-14T00:00:00.000Z',
});

describe('App Studio conversation history', () => {
  it('keeps coordinator conversations and excludes ordinary project chats', () => {
    const sessions = [session(1, 'explore'), session(2, 'app_orchestrator'), session(3, 'build')];

    expect(appStudioConversations(sessions, 2).map((item) => item.id)).toEqual([2]);
  });

  it('keeps the persisted coordinator during legacy agent repair', () => {
    const sessions = [session(4, null), session(5, 'explore')];

    expect(appStudioConversations(sessions, 4).map((item) => item.id)).toEqual([4]);
  });
});
