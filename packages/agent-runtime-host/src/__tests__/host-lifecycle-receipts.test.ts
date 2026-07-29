import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
import {
  consumeActiveAttemptReceipt,
  consumePreparedAttemptReceipt,
  inspectPreparedAttemptReceiptForTesting,
  inspectActiveAttemptAuthority,
  installActiveAttemptAuthority,
  mintPreparedAttemptReceipt,
} from '../driver/HostLifecycleReceipts.js';
import { HostLifecycleReceiptOwner } from '../driver/HostLifecycleReceiptOwner.js';
import {
  RUNTIME,
  prepareAttempt,
} from './host-lifecycle-driver-support.js';
import { identity } from './attempt-channel-support.js';

function facts() {
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

describe('host lifecycle receipts', () => {
  it('moves a Prepared snapshot once and rejects transplant or forgery', () => {
    const owner = {};
    const foreign = {};
    const source = facts();
    const receipt = mintPreparedAttemptReceipt(owner, source);
    source.prepare.encodedSpec.fill(9);

    expect(() => consumePreparedAttemptReceipt(
      receipt,
      foreign,
    )).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
    const moved = consumePreparedAttemptReceipt(receipt, owner);
    expect(moved.prepare.encodedSpec).toEqual(Uint8Array.of(1));
    expect(moved.prepare).not.toBe(source.prepare);
    expect(() => consumePreparedAttemptReceipt(
      receipt,
      owner,
    )).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
    expect(() => consumePreparedAttemptReceipt(
      {} as never,
      owner,
    )).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
  });

  it('bounds, revokes, and scrubs the owner Prepared slot', () => {
    const owner = new HostLifecycleReceiptOwner();
    const receipt = owner.mintPrepared(facts());
    const retained = inspectPreparedAttemptReceiptForTesting(receipt);
    if (!retained) throw new Error('Prepared receipt state expected');
    const encodedSpec = retained.prepare.encodedSpec;

    owner.revokePrepared();

    expect(inspectPreparedAttemptReceiptForTesting(receipt)).toBeUndefined();
    expect(retained.prepare.encodedSpec.byteLength).toBe(0);
    expect(encodedSpec).toEqual(new Uint8Array(encodedSpec.byteLength));
    expect(() => owner.consumePrepared(receipt)).toThrow(
      expect.objectContaining({ code: 'invalid_receipt' }),
    );
  });

  it('consumes Active receipts once and binds them to one driver', () => {
    const owner = {};
    const foreign = {};
    const controller = new AbortController();
    const receipt = installActiveAttemptAuthority(owner, {
      identity: identity(),
      connectionId: 'connection',
      runtimeInstanceId: RUNTIME,
      agentRunVersion: 1n,
      attemptVersion: 2n,
      specSha256: new Uint8Array(32),
      activationNonce: new Uint8Array(32).fill(1),
      deadlineAtUnixMs: 100n,
    }, controller.signal);

    expect(() => consumeActiveAttemptReceipt(
      receipt,
      foreign,
    )).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
    const handle = consumeActiveAttemptReceipt(receipt, owner);
    expect(inspectActiveAttemptAuthority(handle, owner)).toMatchObject({
      connectionId: 'connection',
      runtimeInstanceId: RUNTIME,
      agentRunVersion: 1n,
      attemptVersion: 2n,
      deadlineAtUnixMs: 100n,
    });
    expect(() => consumeActiveAttemptReceipt(
      receipt,
      owner,
    )).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
    expect(() => consumeActiveAttemptReceipt(
      {} as never,
      owner,
    )).toThrow(expect.objectContaining({ code: 'invalid_receipt' }));
    controller.abort(new Error('revoked'));
    expect(() => inspectActiveAttemptAuthority(
      handle,
      owner,
    )).toThrow(expect.objectContaining({
      code: 'active_authority_revoked',
    }));
  });
});
