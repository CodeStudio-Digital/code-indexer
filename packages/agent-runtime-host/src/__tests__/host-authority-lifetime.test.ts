import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import { HostAuthorityLifetime } from '../driver/HostAuthorityLifetime.js';
import type {
  PreparedDurabilityFacts,
} from '../driver/HostLifecycleTypes.js';
import { createAuthorityClockForTesting } from '../ipc/AttemptClock.js';
import {
  RUNTIME,
  grantForFacts,
  prepareAttempt,
} from './host-lifecycle-driver-support.js';
import { identity } from './attempt-channel-support.js';

function facts(): PreparedDurabilityFacts {
  return {
    connectionId: 'connection',
    prepareMessageId: 'prepare-message',
    preparedMessageId: 'prepared-message',
    prepare: prepareAttempt(),
    prepared: create(agentV1Runtime.AttemptPreparedSchema, {
      identity: identity(),
      runtimeInstanceId: RUNTIME,
      specSha256: new Uint8Array(32),
      readyAtUnixMs: 10n,
    }),
  };
}

describe('host authority lifetime', () => {
  it('does not dispatch durability after a pre-dispatch abort', async () => {
    const value = facts();
    const port = {
      commitPrepared: vi.fn(async () => grantForFacts(value)),
    };
    const lifetime = new HostAuthorityLifetime(
      createAuthorityClockForTesting(() => 10n),
      20n,
      () => undefined,
    );

    const pending = lifetime.commitPrepared(port, value);
    lifetime.abort(new Error('aborted before dispatch'));

    await expect(pending).rejects.toThrow('aborted before dispatch');
    expect(port.commitPrepared).toHaveBeenCalledTimes(0);
  });
});
