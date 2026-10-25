import { describe, expect, it } from 'vitest';
import type { AgentsGroup, AssistantTurn } from '../../../../hooks/agent-stream/types.js';
import type { SessionData } from '../../types.js';
import { collectListedGroups, collectPersistedGroups } from '../subagents-panel-data.js';

function sessionData(
  status: 'running' | 'idle',
  result?: string,
): SessionData {
  return {
    session: { id: '018f0f5e-7b2d-7a45-8c11-0123456789ab', status },
    message_rows: [],
    messages: [
      {
        role: 'assistant',
        content: [{
          type: 'tool_use',
          id: 'spawn-1',
          name: 'spawn_agent',
          input: { agents: [{ label: 'Investigator', task: 'Trace the runtime', type: 'investigator' }] },
        }],
      },
      ...(result === undefined ? [] : [{
        role: 'tool' as const,
        content: [{ type: 'tool_result' as const, tool_use_id: 'spawn-1', content: result }],
      }]),
    ],
  } as unknown as SessionData;
}

function liveGroup(status: AgentsGroup['status']): AssistantTurn {
  return {
    blocks: [{
      type: 'agents',
      group: {
        groupId: 'live-1',
        toolUseId: 'spawn-1',
        status,
        agents: [{
          index: 0,
          label: 'Investigator',
          task: 'Trace the runtime',
          status: status === 'running' ? 'running' : 'completed',
          toolCallCount: 2,
        }],
      },
    }],
  };
}

describe('subagents panel data', () => {
  it('reuses saved history across live updates without retaining a stale active group', () => {
    const data = sessionData('running');
    const history = collectPersistedGroups(data);
    const before = structuredClone(history);
    expect(collectListedGroups(data, liveGroup('running'), history).activeGroups).toHaveLength(1);
    const completed = collectListedGroups(data, liveGroup('completed'), history);
    expect(completed.activeGroups).toHaveLength(0);
    expect(completed.recentGroups).toHaveLength(1);
    expect(history).toEqual(before);
  });
  it('uses the live group and suppresses its persisted duplicate', () => {
    const data = sessionData('running');
    const groups = collectListedGroups(data, liveGroup('running'));

    expect(groups.activeGroups).toHaveLength(1);
    expect(groups.activeGroups[0]).toMatchObject({ source: 'live', key: 'live:live-1' });
    expect(groups.recentGroups).toHaveLength(0);
  });

  it('reconstructs a stable completed group from session history', () => {
    const data = sessionData(
      'idle',
      '[subagent provider=chatgpt model=gpt-5 type=investigator reason=completed input=10 output=5]\n\nRuntime traced.',
    );
    const groups = collectListedGroups(data, null);

    expect(groups.activeGroups).toHaveLength(0);
    expect(groups.recentGroups).toHaveLength(1);
    expect(groups.recentGroups[0]).toMatchObject({
      source: 'history',
      key: 'history:spawn-1',
      group: { groupId: 'persisted-spawn-1', status: 'completed' },
    });
    expect(groups.recentGroups[0]?.group.agents[0]?.summary).toBe('Runtime traced.');
  });

  it('treats an unresolved persisted spawn as active only while the session runs', () => {
    expect(collectListedGroups(sessionData('running'), null).activeGroups).toHaveLength(1);
    expect(collectListedGroups(sessionData('idle'), null).recentGroups).toHaveLength(1);
  });

  it('deduplicates reconstructed progress by tool identity even when task metadata is absent', () => {
    const live: AssistantTurn = {
      blocks: [{
        type: 'agents',
        group: {
          groupId: 'reattached-live',
          toolUseId: 'spawn-1',
          status: 'running',
          agents: [{ index: 0, label: 'Investigator', status: 'running', toolCallCount: 7 }],
        },
      }],
    };

    const groups = collectListedGroups(sessionData('running'), live);
    expect(groups.activeGroups).toHaveLength(1);
    expect(groups.recentGroups).toHaveLength(0);
  });

  it('keeps repeated tasks distinct when their canonical tool ids differ', () => {
    const data = sessionData('idle');
    const live: AssistantTurn = {
      blocks: [{
        type: 'agents',
        group: {
          groupId: 'live-2',
          toolUseId: 'spawn-2',
          status: 'running',
          agents: [{ index: 0, label: 'Investigator', task: 'Trace the runtime', status: 'running', toolCallCount: 0 }],
        },
      }],
    };

    const groups = collectListedGroups(data, live);
    expect(groups.activeGroups).toHaveLength(1);
    expect(groups.recentGroups).toHaveLength(1);
    expect(groups.recentGroups[0]?.key).toBe('history:spawn-1');
  });
});
