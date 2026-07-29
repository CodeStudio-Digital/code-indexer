import { describe, expect, it, vi } from 'vitest';
import { InMemoryTelemetrySink } from '@mcp/candidate-pipeline';
import type { CounterfactualLogStore } from '@mcp/store/counterfactual-log-store.js';
import { ShadowTrafficRunner } from '../shadow-traffic-runner.js';

describe('ShadowTrafficRunner post-cut boundary', () => {
  it('does not flatten a session observation into the global counterfactual store', async () => {
    const insert = vi.fn();
    const telemetry = new InMemoryTelemetrySink();
    const sessionId = '018f0f5e-7b2d-7a45-8c11-0123456789ab';
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [{
        name: 'k_8',
        enable: () => true,
        run: async () => ({ selected: ['read_file'] }),
      }],
      store: { insert } as unknown as CounterfactualLogStore,
      telemetry,
      sampleRate: 1,
      scheduler: (run) => run(),
    });

    await runner.runVariants(
      { queryHash: 'query', payload: {}, sessionId },
      { selected: ['read_file', 'edit_file'] },
    );

    expect(insert).not.toHaveBeenCalled();
    expect(telemetry.events).toEqual([
      expect.objectContaining({
        sessionId,
        component: 'shadow/k_8',
        diag: {
          query_hash: 'query',
          production_choice: { selected: ['read_file', 'edit_file'] },
          shadow_prediction: { selected: ['read_file'] },
          error: null,
        },
      }),
    ]);
  });

  it('continues to persist genuinely global observations', async () => {
    const insert = vi.fn();
    const runner = new ShadowTrafficRunner({
      pipelineName: 'tool_selection',
      variants: [{
        name: 'k_8',
        enable: () => true,
        run: async () => ({ selected: [] }),
      }],
      store: { insert } as unknown as CounterfactualLogStore,
      sampleRate: 1,
      scheduler: (run) => run(),
    });

    await runner.runVariants(
      { queryHash: 'global-query', payload: {} },
      { selected: [] },
    );

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      pipeline_name: 'tool_selection',
      shadow_variant: 'k_8',
    }));
  });
});
