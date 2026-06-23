/**
 * Tests for CoderTunables — focus on the contract that A1 added:
 *
 *   - envTunables() reads CODER_* env vars with hardcoded fallbacks
 *   - mergeTunables() honors only finite positive numbers in the override
 *   - DEFAULT_TUNABLES matches the legacy hardcoded constants
 *
 * Bit-identical behavior is the safety property: without env vars and
 * without explicit overrides, the runner gets DEFAULT_TUNABLES values
 * — same as the pre-A1 module-level constants.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_TUNABLES,
  envTunables,
  mergeTunables,
  type CoderTunables,
} from '../tunables.js';

const ENV_KEYS = [
  'CODER_PUSH_TIME_CAP',
  'CODER_SUBAGENT_PUSH_TIME_CAP',
  'CODER_UNRESTRICTED_PUSH_TIME_CAP',
  'CODER_UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP',
  'CODER_TURN_BUDGET_CHARS',
  'CODER_TOOL_MISUSE_INTERVENTION_COOLDOWN',
];

describe('CoderTunables', () => {
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      original[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  describe('DEFAULT_TUNABLES', () => {
    it('matches the legacy hardcoded constants', () => {
      expect(DEFAULT_TUNABLES.pushTimeCap).toBe(24_000);
      expect(DEFAULT_TUNABLES.subagentPushTimeCap).toBe(12_000);
      expect(DEFAULT_TUNABLES.unrestrictedPushTimeCap).toBe(1_000_000);
      expect(DEFAULT_TUNABLES.unrestrictedSubagentPushTimeCap).toBe(500_000);
      expect(DEFAULT_TUNABLES.turnBudgetChars).toBe(30_000);
      expect(DEFAULT_TUNABLES.interventionCooldownTurns).toBe(5);
    });

    it('is frozen', () => {
      expect(Object.isFrozen(DEFAULT_TUNABLES)).toBe(true);
    });
  });

  describe('envTunables', () => {
    it('returns DEFAULT_TUNABLES when no env vars are set', () => {
      expect(envTunables()).toEqual(DEFAULT_TUNABLES);
    });

    it('honors each CODER_* env var', () => {
      process.env.CODER_PUSH_TIME_CAP = '48000';
      process.env.CODER_SUBAGENT_PUSH_TIME_CAP = '20000';
      process.env.CODER_TURN_BUDGET_CHARS = '60000';
      process.env.CODER_TOOL_MISUSE_INTERVENTION_COOLDOWN = '10';
      const t = envTunables();
      expect(t.pushTimeCap).toBe(48_000);
      expect(t.subagentPushTimeCap).toBe(20_000);
      expect(t.turnBudgetChars).toBe(60_000);
      expect(t.interventionCooldownTurns).toBe(10);
      // Untouched keys keep defaults.
      expect(t.unrestrictedPushTimeCap).toBe(DEFAULT_TUNABLES.unrestrictedPushTimeCap);
    });

    it('falls back to default when env value is not a finite positive number', () => {
      process.env.CODER_PUSH_TIME_CAP = 'not-a-number';
      expect(envTunables().pushTimeCap).toBe(DEFAULT_TUNABLES.pushTimeCap);
      process.env.CODER_PUSH_TIME_CAP = '0';
      expect(envTunables().pushTimeCap).toBe(DEFAULT_TUNABLES.pushTimeCap);
      process.env.CODER_PUSH_TIME_CAP = '-100';
      expect(envTunables().pushTimeCap).toBe(DEFAULT_TUNABLES.pushTimeCap);
      process.env.CODER_PUSH_TIME_CAP = '';
      expect(envTunables().pushTimeCap).toBe(DEFAULT_TUNABLES.pushTimeCap);
    });
  });

  describe('mergeTunables', () => {
    const base: CoderTunables = { ...DEFAULT_TUNABLES };

    it('returns base unchanged when override is empty', () => {
      expect(mergeTunables(base, {})).toEqual(base);
    });

    it('applies finite positive numeric overrides', () => {
      const merged = mergeTunables(base, {
        pushTimeCap: 48_000,
        turnBudgetChars: 100_000,
      });
      expect(merged.pushTimeCap).toBe(48_000);
      expect(merged.turnBudgetChars).toBe(100_000);
      expect(merged.subagentPushTimeCap).toBe(base.subagentPushTimeCap);
    });

    it('ignores non-numeric, NaN, Infinity, zero, and negative overrides', () => {
      const merged = mergeTunables(base, {
        pushTimeCap: 'lots' as unknown as number,
        subagentPushTimeCap: NaN,
        turnBudgetChars: Infinity,
        unrestrictedPushTimeCap: 0,
        unrestrictedSubagentPushTimeCap: -1,
        interventionCooldownTurns: null as unknown as number,
      });
      expect(merged).toEqual(base);
    });

    it('does not mutate the base or the override', () => {
      const baseSnapshot = { ...base };
      const override = { pushTimeCap: 99_999 };
      const overrideSnapshot = { ...override };
      mergeTunables(base, override);
      expect(base).toEqual(baseSnapshot);
      expect(override).toEqual(overrideSnapshot);
    });
  });
});
