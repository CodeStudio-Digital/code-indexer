import { Hono } from 'hono';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDeps } from '../../../deps.js';
import type { CoderRuntime } from '../state.js';
import { mountCoderPipelineRoutes } from '../pipelines.js';

const SESSION_ID =
  asSessionId('11111111-1111-4111-8111-111111111111');
const EXECUTION_ID = '22222222-2222-4222-8222-222222222222';

function setup() {
  const listExecutions = vi.fn(async () => [{
    id: EXECUTION_ID,
    coder_session_id: SESSION_ID,
    pipeline_id: 7,
    status: 'completed',
  }]);
  const getExecution = vi.fn(async () => ({
    id: EXECUTION_ID,
    coder_session_id: SESSION_ID,
    pipeline_id: 7,
    status: 'completed',
  }));
  const listNodeExecutions = vi.fn(async () => [{
    id: '33333333-3333-4333-8333-333333333333',
    execution_id: EXECUTION_ID,
  }]);
  const app = new Hono();
  mountCoderPipelineRoutes(
    app,
    {
      sessionStore: {
        chatPipelines: {
          listExecutions,
          getExecution,
          listNodeExecutions,
        },
      },
      companyStore: {},
    } as unknown as ServerDeps,
    {
      coderPipelineRegistry: { get: () => undefined },
    } as unknown as CoderRuntime,
  );
  return {
    app,
    listExecutions,
    getExecution,
    listNodeExecutions,
  };
}

describe('coder pipeline execution filesystem routes', () => {
  it('lists persisted executions from the owning session bundle', async () => {
    const { app, listExecutions } = setup();

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/pipelines/executions?pipeline_id=7&status=completed`,
    );

    expect(response.status).toBe(200);
    expect(listExecutions).toHaveBeenCalledWith(SESSION_ID, {
      pipeline_id: 7,
      status: 'completed',
    });
    expect(await response.json()).toEqual([
      expect.objectContaining({ id: EXECUTION_ID }),
    ]);
  });

  it('loads execution and node UUID records without a live executor', async () => {
    const { app, getExecution, listNodeExecutions } = setup();

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/pipelines/executions/${EXECUTION_ID}`,
    );

    expect(response.status).toBe(200);
    expect(getExecution).toHaveBeenCalledWith(SESSION_ID, EXECUTION_ID);
    expect(listNodeExecutions).toHaveBeenCalledWith(
      SESSION_ID,
      EXECUTION_ID,
    );
    expect(await response.json()).toMatchObject({
      execution: { id: EXECUTION_ID },
      nodes: [expect.objectContaining({
        execution_id: EXECUTION_ID,
      })],
    });
  });

  it('rejects legacy numeric execution ids at the HTTP boundary', async () => {
    const { app, getExecution } = setup();

    const response = await app.request(
      `/api/coder/sessions/${SESSION_ID}/pipelines/executions/42`,
    );

    expect(response.status).toBe(400);
    expect(getExecution).not.toHaveBeenCalled();
  });
});
