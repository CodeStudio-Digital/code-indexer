import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateInvoice } from '../src/billing/invoice.js';

test('rounds once after discount and tax to avoid intermediate-cent drift', () => {
  assert.equal(
    calculateInvoice({ subtotal: 10.03, discountRate: 0.17, taxRate: 0.19 }),
    9.91,
  );
});

test('keeps the ordinary two-decimal case stable', () => {
  assert.equal(
    calculateInvoice({ subtotal: 100, discountRate: 0.1, taxRate: 0.2 }),
    108,
  );
});
