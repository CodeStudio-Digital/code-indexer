import { describe, expect, it } from 'vitest';
import {
  CODE_RUN_ROLLOUT_MANIFEST,
  validateCodeRunRolloutEntries,
  validateCodeRunRolloutManifest,
} from './rollout-manifest.js';

const current = [
  'CODER_AGENT_RUN_STORE_ENFORCE',
  'CODER_AGENT_RUN_STORE_SHADOW',
  'CODER_CONTROL_PLANE_SHADOW',
  'CODER_RUNTIME_JOURNAL_SHADOW',
];

describe('code-run rollout manifest', () => {
  it('covers every current temporary switch before expiry', () => {
    expect(validateCodeRunRolloutManifest(current, new Date('2026-08-05T00:00:00Z'))).toEqual({
      ok: true,
      missing: [],
      expired: [],
      duplicate: [],
      invalid: [],
    });
  });

  it('rejects undeclared and expired rollout debt', () => {
    const result = validateCodeRunRolloutManifest(
      [...current, 'CODER_UNDECLARED_SHADOW'],
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('CODER_UNDECLARED_SHADOW');
    expect(result.expired).toEqual(current);
  });

  it('rejects an incomplete canary, receipt, or retirement contract', () => {
    const broken = CODE_RUN_ROLLOUT_MANIFEST.map((entry, index) => index === 0
      ? { ...entry, canaryStages: ['100%'], receiptPrefix: 'somewhere/else' }
      : entry);
    const result = validateCodeRunRolloutEntries(
      broken,
      current,
      new Date('2026-08-05T00:00:00Z'),
    );
    expect(result.ok).toBe(false);
    expect(result.invalid).toEqual(['CODER_AGENT_RUN_STORE_ENFORCE']);
  });
});
