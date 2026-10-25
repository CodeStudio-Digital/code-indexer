import { describe, expect, it } from 'vitest';
import {
  REQUIRED_CODE_RUN_CANARY_STAGES,
  REQUIRED_CODE_RUN_STOP_CONDITIONS,
  type CodeRunRolloutEntry,
  validateCodeRunRolloutEntries,
  validateCodeRunRolloutManifest,
} from './rollout-manifest.js';
import { classifyRuntimeEnv } from './disposition.js';

const retired = [
  'CODER_AGENT_RUN_STORE_ENFORCE',
  'CODER_AGENT_RUN_STORE_SHADOW',
  'CODER_CONTROL_PLANE_SHADOW',
  'CODER_RUNTIME_JOURNAL_SHADOW',
];

const fixture: CodeRunRolloutEntry = {
  key: 'CODER_FIXTURE_SHADOW',
  owner: 'runtime-test',
  introducedAt: '2026-08-05',
  expiresAt: '2026-09-30',
  promotionMetric: 'zero parity defects',
  rollbackReceipt: 'restore the previous validated build',
  receiptPrefix: 'docs/architecture/code-run-refactor/results/rollouts/CODER_FIXTURE_SHADOW',
  canaryStages: REQUIRED_CODE_RUN_CANARY_STAGES,
  stopConditions: REQUIRED_CODE_RUN_STOP_CONDITIONS,
  retirementAction: 'remove_shadow_switch',
};

describe('code-run rollout manifest', () => {
  it('has no remaining rollout debt after retiring the migration switches', () => {
    expect(validateCodeRunRolloutManifest([], new Date('2026-10-24T00:00:00Z'))).toEqual({
      ok: true,
      missing: [],
      expired: [],
      duplicate: [],
      invalid: [],
    });
  });

  it('rejects any reintroduced consumer of a retired rollout switch', () => {
    for (const key of retired) {
      expect(classifyRuntimeEnv(key)?.disposition).toBe('ROLLOUT_TEMP');
    }
    const result = validateCodeRunRolloutManifest(retired);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(retired);
  });

  it('accepts a complete future rollout contract before expiry', () => {
    expect(validateCodeRunRolloutEntries([fixture], [fixture.key], new Date('2026-09-30T00:00:00Z')).ok).toBe(true);
  });

  it('rejects undeclared and expired rollout debt', () => {
    const result = validateCodeRunRolloutEntries(
      [fixture],
      [fixture.key, 'CODER_UNDECLARED_SHADOW'],
      new Date('2026-10-01T00:00:00Z'),
    );
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('CODER_UNDECLARED_SHADOW');
    expect(result.expired).toEqual([fixture.key]);
  });

  it('rejects an incomplete canary, receipt, or retirement contract', () => {
    const broken = [{ ...fixture, canaryStages: ['100%'], receiptPrefix: 'somewhere/else' }];
    const result = validateCodeRunRolloutEntries(
      broken,
      [fixture.key],
      new Date('2026-08-05T00:00:00Z'),
    );
    expect(result.ok).toBe(false);
    expect(result.invalid).toEqual([fixture.key]);
  });

  it('rejects duplicate rollout contracts', () => {
    const result = validateCodeRunRolloutEntries([fixture, fixture], [fixture.key], new Date('2026-08-05T00:00:00Z'));
    expect(result.ok).toBe(false);
    expect(result.duplicate).toEqual([fixture.key]);
  });
});
