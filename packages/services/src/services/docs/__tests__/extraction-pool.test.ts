import { describe, expect, it } from 'vitest';
import { availableDocExtractionWorkers, resolveDocWorkerCount } from '../index-doc-use-case/extraction-pool.js';

describe('documentation extraction performance profiles', () => {
  it('keeps every profile within the safe worker ceiling', () => {
    const available = availableDocExtractionWorkers();
    expect(resolveDocWorkerCount('economy')).toBeLessThanOrEqual(Math.max(2, available));
    expect(resolveDocWorkerCount('balanced')).toBeGreaterThanOrEqual(1);
    expect(resolveDocWorkerCount('maximum')).toBeLessThanOrEqual(12);
    expect(resolveDocWorkerCount('custom', 999)).toBe(16);
    expect(resolveDocWorkerCount('custom', 0)).toBe(1);
  });
});
