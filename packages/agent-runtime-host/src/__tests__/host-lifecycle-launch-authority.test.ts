import { Readable } from 'node:stream';
import {
  agentV1Common,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  HostLifecycleLaunchAuthority,
} from '../driver/HostLifecycleLaunchAuthority.js';
import { DelimitedByteChannel } from '../ipc/DelimitedByteChannel.js';
import {
  MAXIMUM,
  captureWritable,
  launchProvision,
} from './attempt-channel-support.js';
import {
  preparedArtifacts,
  preparedSnapshots,
} from './host-lifecycle-driver-support.js';
import { activationAuthoritySeal } from './activation-authority-support.js';

describe('host lifecycle launch authority', () => {
  it('rejects a spec deadline beyond launch before reading transport', () => {
    let reads = 0;
    const readable = new Readable({
      read() {
        reads += 1;
      },
    });
    const transport = new DelimitedByteChannel(
      readable,
      captureWritable().writable,
      { maximumFrameBytes: MAXIMUM },
    );

    expect(() => HostLifecycleLaunchAuthority.provision({
      ...launchProvision(transport),
      expectedSnapshots: preparedSnapshots(),
      expectedArtifacts: preparedArtifacts(),
      requiredContainmentLevel:
        agentV1Common.ContainmentLevel.HARD_PROCESS,
      requiredEnforcedLimits: [
        agentV1Common.ResourceLimitKind.MEMORY,
      ],
      specDeadlineAtUnixMs: 70_001n,
      activationAuthoritySeal: activationAuthoritySeal(),
    })).toThrow(expect.objectContaining({
      code: 'invalid_prepared_expectation',
    }));
    expect(reads).toBe(0);
  });
});
