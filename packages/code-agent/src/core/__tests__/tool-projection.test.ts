import { expect, it } from 'vitest';
import { toolProjectionReceipt } from '../tool-projection.js';

it('reports rejected bootstrap tools even without a discovery activation request', () => {
  const receipt = toolProjectionReceipt([], new Set(['healthy']), new Set(['healthy', 'broken']), 'p', 'c', new Set(['broken']));
  expect(receipt.deferred).toEqual([{ name: 'broken', reason: 'provider_schema_rejected' }]);
  expect(receipt.discovery.tools).toEqual([{ name: 'broken', state: 'deferred', reason: 'provider_schema_rejected' }]);
});

it('confirms only the outgoing projection, distinguishing budgets from authorization', () => {
  expect(toolProjectionReceipt(['read', 'write', 'missing', 'read'], new Set(['read']), new Set(['read', 'write']), 'p2', 'c1'))
    .toEqual({ version: 2, projectionDigest: 'p2', catalogDigest: 'c1', confirmed: ['read'], deferred: [
      { name: 'missing', reason: 'not_authorized' }, { name: 'write', reason: 'projection_budget' },
    ], discovery: { schemaVersion: 1, revision: 'c1:p2', tools: [
      { name: 'missing', state: 'denied', reason: 'not_authorized' },
      { name: 'read', state: 'callable' },
      { name: 'write', state: 'deferred', reason: 'projection_budget' },
    ] } });
});
