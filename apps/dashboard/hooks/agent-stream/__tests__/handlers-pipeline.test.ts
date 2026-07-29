import { describe, expect, it, vi } from 'vitest';
import { createPipelineEventHandlers } from '../handlers.js';
import type {
  PipelineRuntimeState,
  SessionPatch,
  SessionState,
  UpdateSession,
} from '../types.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';

describe('pipeline event handlers', () => {
  it('keeps opaque execution UUIDs and fences updates by that UUID', () => {
    const updateSession: UpdateSession = vi.fn();
    const handlers = createPipelineEventHandlers({
      sid: SESSION_ID,
      updateSession,
    });

    handlers.pipeline_started(
      {
        executionId: EXECUTION_ID,
        pipelineId: 7,
        startNodeId: 'inspect',
      },
      'pipeline_started',
    );

    expect(updateSession).toHaveBeenNthCalledWith(1, SESSION_ID, {
      pipelineRuntime: {
        executionId: EXECUTION_ID,
        pipelineId: 7,
        status: 'running',
        currentNodeId: 'inspect',
        nodes: { inspect: { status: 'pending' } },
        error: null,
      },
    });

    const runtime = (vi.mocked(updateSession).mock.calls[0][1] as {
      pipelineRuntime: PipelineRuntimeState;
    }).pipelineRuntime;

    handlers.pipeline_node_started(
      {
        executionId: EXECUTION_ID,
        nodeId: 'inspect',
        nodeLabel: 'Inspect',
      },
      'pipeline_node_started',
    );
    const matchingPatch = applyPatch(
      vi.mocked(updateSession).mock.calls[1][1],
      { pipelineRuntime: runtime } as SessionState,
    );
    expect(matchingPatch.pipelineRuntime).toMatchObject({
      executionId: EXECUTION_ID,
      currentNodeId: 'inspect',
      nodes: { inspect: { status: 'running', label: 'Inspect' } },
    });

    handlers.pipeline_completed(
      { executionId: '33333333-3333-4333-8333-333333333333' },
      'pipeline_completed',
    );
    expect(applyPatch(
      vi.mocked(updateSession).mock.calls[2][1],
      { pipelineRuntime: runtime } as SessionState,
    )).toEqual({});
  });
});

function applyPatch(patch: SessionPatch, state: SessionState): Partial<SessionState> {
  return typeof patch === 'function' ? patch(state) : patch;
}
