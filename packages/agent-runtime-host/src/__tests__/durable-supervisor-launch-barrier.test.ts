import { describe, expect, it, vi } from 'vitest';
import {
  DurableSupervisorLaunchBarrier,
} from '../driver/DurableSupervisorLaunchBarrier.js';
import type {
  DurableSupervisorFactCommitControl,
  SupervisorFactBinding,
} from '../driver/HostSupervisorFactTypes.js';
import { activationAuthoritySeal } from './activation-authority-support.js';
import {
  acceptedFact, containmentFact, exitedFact, spawnedFact,
} from './host-supervisor-fact-support.js';

describe('DurableSupervisorLaunchBarrier', () => {
  it('cannot repopulate retained facts after a late durable settlement', async () => {
    const late = deferred();
    const durable = {
      commit: vi.fn(() => late.promise),
    };
    const barrier = new DurableSupervisorLaunchBarrier(durable);
    barrier.bindActivationAuthoritySeal(activationAuthoritySeal());
    const committing = barrier.commit(
      acceptedFact(),
      binding(),
      commitControl(),
    );

    barrier.discard();
    late.resolve();
    await committing;

    expect(barrier.outcome).toBe('pending');
    expect(() => barrier.releaseAccepted()).toThrow(expect.objectContaining({
      code: 'management_barrier',
    }));
  });

  it('becomes a transparent durable writer after releasing containment', async () => {
    const durable = { commit: vi.fn(async () => undefined) };
    const barrier = new DurableSupervisorLaunchBarrier(durable);
    barrier.bindActivationAuthoritySeal(activationAuthoritySeal());
    for (const fact of [acceptedFact(), spawnedFact(), containmentFact()]) {
      await barrier.commit(fact, binding(), commitControl());
    }
    barrier.releaseAccepted();

    await expect(barrier.commit(
      exitedFact(),
      binding(),
      commitControl(),
    )).resolves.toBeUndefined();
    expect(durable.commit).toHaveBeenCalledTimes(4);
  });
});

function binding(): SupervisorFactBinding {
  return {
    connectionId: 'management:test',
    messageId: 'accepted',
    streamSeq: 2n,
    payloadSha256: new Uint8Array(32),
    envelopeSha256: new Uint8Array(32),
    observedAtUnixMs: 10n,
  };
}

function commitControl(): DurableSupervisorFactCommitControl {
  return Object.freeze({
    signal: new AbortController().signal,
    deadlineAtUnixMs: 100n,
    idempotencyKey: 'accepted',
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
