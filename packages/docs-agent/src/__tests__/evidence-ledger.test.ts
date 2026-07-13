import { describe, expect, it } from 'vitest';
import { DocsEvidenceLedger } from '../tools/evidence-ledger.js';

describe('DocsEvidenceLedger', () => {
  it('enforces search/read/citation budgets', () => {
    const ledger = new DocsEvidenceLedger(1, 1, 2);
    expect(ledger.canSearch()).toBe(true);
    ledger.recordSearch(0, [10, 11]);
    expect(ledger.canSearch()).toBe(false);
    ledger.recordRead([10]);
    expect(ledger.canRead()).toBe(false);
    expect(ledger.validateHighConfidence(1, [10, 11, 12])).toMatch(/at most 2/);
  });

  it('rejects high confidence when any sub-question lacks read and cited evidence', () => {
    const ledger = new DocsEvidenceLedger();
    ledger.recordSearch(0, [10]);
    ledger.recordSearch(1, [20]);
    ledger.recordRead([10]);
    expect(ledger.validateHighConfidence(2, [10])).toMatch(/sub-questions.*2/);
    ledger.recordRead([20]);
    expect(ledger.validateHighConfidence(2, [10, 20])).toBeNull();
  });

  it('rejects citations that were never hydrated', () => {
    const ledger = new DocsEvidenceLedger();
    ledger.recordSearch(0, [42]);
    expect(ledger.validateHighConfidence(1, [42])).toMatch(/not read in full/);
  });
});
