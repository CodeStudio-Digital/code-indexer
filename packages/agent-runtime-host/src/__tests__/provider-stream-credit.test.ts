import { create } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { expect, it } from 'vitest';
import { ProviderStreamCredit } from '../ipc/ProviderStreamCredit.js';

it('releases a single credit only for the exact operation and sequence', async () => {
  const credit = new ProviderStreamCredit('stream/1');
  const consumed = credit.reserve(1n);
  const receipt = create(agentV1Runtime.ProviderEventConsumedSchema, { operationId: 'stream/1', eventSequence: 1n });
  expect(() => credit.reserve(2n)).toThrow();
  expect(() => credit.acknowledge({ ...receipt, operationId: 'foreign' })).toThrow();
  expect(() => credit.acknowledge({ ...receipt, eventSequence: 2n })).toThrow();
  let released = false;
  const pending = consumed().then(() => { released = true; });
  await Promise.resolve(); expect(released).toBe(false);
  credit.acknowledge(receipt); await pending;
  expect(released).toBe(true);
  expect(() => credit.acknowledge(receipt)).toThrow();
  const next = credit.reserve(2n)();
  credit.close(new Error('closed'));
  await expect(next).rejects.toThrow('closed');
});

it('cancels a blocked stream and retires one ACK already in transit', async () => {
  const credit = new ProviderStreamCredit('stream/1');
  const controller = new AbortController();
  const pending = credit.reserve(1n)(controller.signal);
  controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow('cancelled');
  const receipt = create(agentV1Runtime.ProviderEventConsumedSchema, {
    operationId: 'stream/1', eventSequence: 1n,
  });
  expect(() => credit.acknowledge(receipt)).not.toThrow();
  expect(() => credit.acknowledge(receipt)).toThrow();
});
