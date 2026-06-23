import { describe, expect, it } from 'vitest';
import { buildExecutionGraph } from '../ExecutionMapGraph.js';
import type { WorkerLogEntry } from '../../../hooks/agent-stream/types.js';

function entry(event: string, data: unknown): WorkerLogEntry {
  return {
    ts: 1,
    event,
    data,
    category: 'runner',
    level: 'info',
    message: event,
  };
}

describe('ExecutionMapGraph', () => {
  it('creates and updates parallel subagent nodes from normalized events', () => {
    const graph = buildExecutionGraph([
      entry('agents_group_start', {
        groupId: 'grp',
        agents: [
          { index: 0, label: 'Explore resources' },
          { index: 1, label: 'Explore models' },
        ],
      }),
      entry('agent_progress', {
        groupId: 'grp',
        agentIndex: 1,
        label: 'Explore models',
        status: 'timed_out',
        phase: 'provider_timeout',
        lastToolName: 'read_file',
      }),
    ]);

    const timedOut = graph.nodes.find((node) => node.id === 'agent:grp:1');
    expect(timedOut?.data.status).toBe('timed_out');
    expect(timedOut?.data.detail).toMatchObject({
      phase: 'provider_timeout',
      lastToolName: 'read_file',
    });
    expect(graph.edges.some((edge) => edge.source === 'group:grp' && edge.target === 'agent:grp:1')).toBe(true);
  });
});
