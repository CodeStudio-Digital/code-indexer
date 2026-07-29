import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import { assertPayloadAllowed } from '../ipc/AttemptFrameChannel.js';
import { assertPayloadDirection } from '../ipc/AttemptFrameDirection.js';

type DataCase =
  | 'bindAttemptChannel'
  | 'attemptChannelBound'
  | 'hydrationManifest'
  | 'hydrationProgress'
  | 'hydrationChunk'
  | 'hydrationComplete'
  | 'hydrationCommitted';

function payload(payloadCase: DataCase): agentV1Runtime.FramePayload {
  const values = {
    bindAttemptChannel: create(agentV1Runtime.BindAttemptChannelSchema),
    attemptChannelBound: create(agentV1Runtime.AttemptChannelBoundSchema),
    hydrationManifest: create(agentV1Runtime.HydrationManifestSchema),
    hydrationProgress: create(agentV1Runtime.HydrationProgressSchema),
    hydrationChunk: create(agentV1Runtime.HydrationChunkSchema),
    hydrationComplete: create(agentV1Runtime.HydrationCompleteSchema),
    hydrationCommitted: create(agentV1Runtime.HydrationCommittedSchema),
  };
  return create(agentV1Runtime.FramePayloadSchema, {
    body: {
      case: payloadCase,
      value: values[payloadCase],
    } as agentV1Runtime.FramePayload['body'],
  });
}

describe('attempt data channel direction', () => {
  it('allows only Host bind, manifest, chunks and completion toward the runner', () => {
    for (const payloadCase of [
      'bindAttemptChannel',
      'hydrationManifest',
      'hydrationChunk',
      'hydrationComplete',
    ] as const) {
      const candidate = payload(payloadCase);
      expect(() => assertPayloadAllowed(
        agentV1Runtime.TransportChannel.DATA,
        candidate,
      )).not.toThrow();
      expect(() => assertPayloadDirection(
        'host_to_runner',
        agentV1Runtime.TransportChannel.DATA,
        candidate,
      )).not.toThrow();
      expect(() => assertPayloadDirection(
        'runner_to_host',
        agentV1Runtime.TransportChannel.DATA,
        candidate,
      )).toThrow(expect.objectContaining({ code: 'direction_mismatch' }));
    }
  });

  it('allows only Bound, Progress and Committed toward the Host', () => {
    for (const payloadCase of [
      'attemptChannelBound',
      'hydrationProgress',
      'hydrationCommitted',
    ] as const) {
      const candidate = payload(payloadCase);
      expect(() => assertPayloadAllowed(
        agentV1Runtime.TransportChannel.DATA,
        candidate,
      )).not.toThrow();
      expect(() => assertPayloadDirection(
        'runner_to_host',
        agentV1Runtime.TransportChannel.DATA,
        candidate,
      )).not.toThrow();
      expect(() => assertPayloadDirection(
        'host_to_runner',
        agentV1Runtime.TransportChannel.DATA,
        candidate,
      )).toThrow(expect.objectContaining({ code: 'direction_mismatch' }));
    }
  });
});
