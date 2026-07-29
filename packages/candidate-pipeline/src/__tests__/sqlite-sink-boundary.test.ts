import { describe, expect, it, vi } from 'vitest';
import type { PipelineTelemetryStore } from '@mcp/store/pipeline-telemetry-store.js';
import { SqliteTelemetrySink } from '../sqlite-sink.js';
import type { TelemetryEvent } from '../stats.js';

function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    pipelineName: 'editor',
    stage: 'side_effect',
    component: 'test',
    durationMs: 2,
    durationBucket: '0-10ms',
    ...overrides,
  };
}

describe('SqliteTelemetrySink post-cut boundary', () => {
  it('persists global events and rejects session-owned events', async () => {
    const insertMany = vi.fn();
    const sink = new SqliteTelemetrySink(
      { insertMany } as unknown as PipelineTelemetryStore,
      { flushThreshold: 100 },
    );

    sink.emit(event());
    sink.emit(event({
      sessionId: '018f0f5e-7b2d-7a45-8c11-0123456789ab',
    }));
    sink.emit(event({
      companySessionId: '018f0f5e-7b2d-7a45-8c11-0123456789ac',
    }));
    await sink.stop();

    expect(insertMany).toHaveBeenCalledTimes(1);
    expect(insertMany).toHaveBeenCalledWith([
      expect.objectContaining({
        pipeline_name: 'editor',
        component_name: 'test',
      }),
    ]);
    const persisted = insertMany.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(persisted[0]).not.toHaveProperty('session_id');
    expect(persisted[0]).not.toHaveProperty('company_session_id');
  });
});
