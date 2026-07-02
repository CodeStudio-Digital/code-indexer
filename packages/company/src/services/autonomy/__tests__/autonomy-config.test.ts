/**
 * C0 — pure resolution tests for the per-session autonomy config.
 * No I/O, no process.env mutation: `resolveAutonomy` takes `env` injected.
 */
import { describe, expect, it } from 'vitest';
import {
  isAutonomyActionAllowed,
  resolveAutonomy,
  type AutonomyConfig,
} from '../autonomy-config.js';

const EMPTY_ENV = {} as NodeJS.ProcessEnv;

describe('resolveAutonomy — C2 organism defaults (ON out of the box)', () => {
  it('empty env + no config → everything ON: scheduler, orphanReset, "*" roles, supervisor, cap 8', () => {
    expect(resolveAutonomy(null, EMPTY_ENV)).toEqual<AutonomyConfig>({
      scheduler: true,
      orphanReset: true,
      autoApproveRoles: '*',
      supervisorMaster: true,
      maxSubordinates: 8,
      wipLimits: {},
      freeze: false,
    });
  });

  it('MCP_COMPANY_SCHEDULER: \'0\' kills scheduler AND orphanReset; \'1\' back-compat ON; blank = default ON', () => {
    const off = resolveAutonomy(undefined, { MCP_COMPANY_SCHEDULER: '0' });
    expect(off.scheduler).toBe(false);
    expect(off.orphanReset).toBe(false);
    // Legacy opt-in value is a harmless no-op now.
    const on = resolveAutonomy(undefined, { MCP_COMPANY_SCHEDULER: '1' });
    expect(on.scheduler).toBe(true);
    expect(on.orphanReset).toBe(true);
    // Blank (the vi.stubEnv('X','') idiom) = absent = default ON.
    expect(resolveAutonomy(null, { MCP_COMPANY_SCHEDULER: '' }).scheduler).toBe(true);
    // 'false'/'off' also read as kill-switch (house style, see autoReestablishEnabled).
    expect(resolveAutonomy(null, { MCP_COMPANY_SCHEDULER: 'off' }).scheduler).toBe(false);
    expect(resolveAutonomy(null, { MCP_COMPANY_SCHEDULER: 'false' }).scheduler).toBe(false);
  });

  it('MCP_SUPERVISOR_MASTER: default ON; \'0\' kills; \'1\' back-compat ON', () => {
    expect(resolveAutonomy(null, EMPTY_ENV).supervisorMaster).toBe(true);
    expect(resolveAutonomy(null, { MCP_SUPERVISOR_MASTER: '0' }).supervisorMaster).toBe(false);
    expect(resolveAutonomy(null, { MCP_SUPERVISOR_MASTER: '1' }).supervisorMaster).toBe(true);
    expect(resolveAutonomy(null, { MCP_SUPERVISOR_MASTER: '' }).supervisorMaster).toBe(true);
  });

  it('MCP_COMPANY_AUTO_APPROVE_ROLES: absent → "*"; PRESENT overrides (csv, "*", blank=OFF)', () => {
    expect(resolveAutonomy(null, EMPTY_ENV).autoApproveRoles).toBe('*');
    expect(
      resolveAutonomy(null, { MCP_COMPANY_AUTO_APPROVE_ROLES: 'frontend, backend,, ' })
        .autoApproveRoles,
    ).toEqual(['frontend', 'backend']);
    expect(
      resolveAutonomy(null, { MCP_COMPANY_AUTO_APPROVE_ROLES: ' * ' }).autoApproveRoles,
    ).toBe('*');
    // An EXPLICIT empty/blank env means OFF — presence overrides the default.
    expect(
      resolveAutonomy(null, { MCP_COMPANY_AUTO_APPROVE_ROLES: '' }).autoApproveRoles,
    ).toBeNull();
    expect(
      resolveAutonomy(null, { MCP_COMPANY_AUTO_APPROVE_ROLES: '  ' }).autoApproveRoles,
    ).toBeNull();
  });

  it('MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: absent/blank/invalid → 8; \'0\' → null (uncapped); int>0 → cap', () => {
    expect(resolveAutonomy(null, EMPTY_ENV).maxSubordinates).toBe(8);
    expect(resolveAutonomy(null, { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '4' }).maxSubordinates).toBe(4);
    expect(resolveAutonomy(null, { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '0' }).maxSubordinates).toBeNull();
    for (const bad of ['-2', 'abc', '3.5', '']) {
      expect(
        resolveAutonomy(null, { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: bad }).maxSubordinates,
      ).toBe(8);
    }
  });
});

describe('resolveAutonomy — session config wins over env', () => {
  const json = (autonomy: unknown) => JSON.stringify({ autonomy });

  it('booleans: session false over default-ON and over env \'1\'; session true over env \'0\'', () => {
    // Session OFF beats the C2 default-on...
    const offByDefaultEnv = resolveAutonomy(
      json({ scheduler: false, orphanReset: false }),
      EMPTY_ENV,
    );
    expect(offByDefaultEnv.scheduler).toBe(false);
    expect(offByDefaultEnv.orphanReset).toBe(false);
    // ...and beats an explicit env opt-in.
    const cfg = resolveAutonomy(
      json({ scheduler: false, orphanReset: false }),
      { MCP_COMPANY_SCHEDULER: '1' },
    );
    expect(cfg.scheduler).toBe(false);
    expect(cfg.orphanReset).toBe(false);
    // Session ON beats the env kill-switch.
    expect(
      resolveAutonomy(json({ scheduler: true }), { MCP_COMPANY_SCHEDULER: '0' }).scheduler,
    ).toBe(true);
    expect(
      resolveAutonomy(json({ supervisorMaster: false }), EMPTY_ENV).supervisorMaster,
    ).toBe(false);
  });

  it('autoApproveRoles: array / "*" / explicit null all override env', () => {
    const env = { MCP_COMPANY_AUTO_APPROVE_ROLES: 'qa' };
    expect(resolveAutonomy(json({ autoApproveRoles: ['dev'] }), env).autoApproveRoles)
      .toEqual(['dev']);
    expect(resolveAutonomy(json({ autoApproveRoles: '*' }), env).autoApproveRoles).toBe('*');
    expect(resolveAutonomy(json({ autoApproveRoles: null }), env).autoApproveRoles).toBeNull();
    // Non-string entries dropped individually; blanks trimmed out.
    expect(
      resolveAutonomy(json({ autoApproveRoles: ['dev', 3, ' qa ', ''] }), env).autoApproveRoles,
    ).toEqual(['dev', 'qa']);
  });

  it('maxSubordinates: session int wins; explicit null = BACK TO DEFAULT POLICY (not uncapped)', () => {
    const env = { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '12' };
    expect(resolveAutonomy(json({ maxSubordinates: 2 }), env).maxSubordinates).toBe(2);
    // C2: session null does NOT lift the cap — env/default resolution stands.
    expect(resolveAutonomy(json({ maxSubordinates: null }), env).maxSubordinates).toBe(12);
    expect(resolveAutonomy(json({ maxSubordinates: null }), EMPTY_ENV).maxSubordinates).toBe(8);
    // Only the env '0' kill-switch reaches "uncapped" — the session cannot.
    expect(
      resolveAutonomy(json({ maxSubordinates: null }), { MCP_COMPANY_GLOBAL_MAX_SUBORDINATES: '0' })
        .maxSubordinates,
    ).toBeNull();
    // Invalid → ignored, env survives.
    expect(resolveAutonomy(json({ maxSubordinates: 0 }), env).maxSubordinates).toBe(12);
    expect(resolveAutonomy(json({ maxSubordinates: 2.5 }), env).maxSubordinates).toBe(12);
  });

  it('wipLimits: known columns with int>0 kept; unknown/invalid dropped', () => {
    const cfg = resolveAutonomy(
      json({ wipLimits: { in_progress: 3, review: 0, bogus: 2, todo: 'x' } }),
      EMPTY_ENV,
    );
    expect(cfg.wipLimits).toEqual({ in_progress: 3 });
  });

  it('freeze: session boolean applies', () => {
    expect(resolveAutonomy(json({ freeze: true }), EMPTY_ENV).freeze).toBe(true);
  });
});

describe('resolveAutonomy — defensive parsing', () => {
  it('invalid JSON → env+defaults only', () => {
    const cfg = resolveAutonomy('{not json', { MCP_COMPANY_SCHEDULER: '0' });
    expect(cfg.scheduler).toBe(false); // env kill-switch survives the bad JSON
    expect(cfg.freeze).toBe(false);
  });

  it('autonomy not an object (array / string / null) → ignored wholesale', () => {
    for (const bad of [[], 'on', null, 42]) {
      const cfg = resolveAutonomy(
        JSON.stringify({ autonomy: bad }),
        { MCP_COMPANY_SCHEDULER: '0' },
      );
      expect(cfg.scheduler).toBe(false); // env stands — nothing overrode it
    }
  });

  it('wrongly-typed fields are ignored INDIVIDUALLY, valid siblings apply', () => {
    const cfg = resolveAutonomy(
      JSON.stringify({ autonomy: { scheduler: 'yes', freeze: true, autoApproveRoles: 7 } }),
      { MCP_COMPANY_SCHEDULER: '0', MCP_COMPANY_AUTO_APPROVE_ROLES: 'qa' },
    );
    expect(cfg.scheduler).toBe(false);        // bad type → env/default survives
    expect(cfg.freeze).toBe(true);            // valid sibling applied
    expect(cfg.autoApproveRoles).toEqual(['qa']); // bad type → env survives
  });
});

describe('isAutonomyActionAllowed', () => {
  const base = resolveAutonomy(null, EMPTY_ENV);

  it('freeze=true denies every action regardless of the other fields', () => {
    const cfg: AutonomyConfig = {
      ...base,
      scheduler: true, orphanReset: true, supervisorMaster: true,
      autoApproveRoles: '*', freeze: true,
    };
    for (const action of ['scheduler', 'autoApprove', 'supervisor', 'orphanReset'] as const) {
      expect(isAutonomyActionAllowed(cfg, action)).toBe(false);
    }
  });

  it('maps each action to its field when not frozen', () => {
    const cfg: AutonomyConfig = {
      ...base, scheduler: true, supervisorMaster: true, orphanReset: false,
    };
    expect(isAutonomyActionAllowed(cfg, 'scheduler')).toBe(true);
    expect(isAutonomyActionAllowed(cfg, 'supervisor')).toBe(true);
    expect(isAutonomyActionAllowed(cfg, 'orphanReset')).toBe(false);
  });

  it('autoApprove: null and [] are off; non-empty array and "*" are on', () => {
    expect(isAutonomyActionAllowed({ ...base, autoApproveRoles: null }, 'autoApprove')).toBe(false);
    expect(isAutonomyActionAllowed({ ...base, autoApproveRoles: [] }, 'autoApprove')).toBe(false);
    expect(isAutonomyActionAllowed({ ...base, autoApproveRoles: ['dev'] }, 'autoApprove')).toBe(true);
    expect(isAutonomyActionAllowed({ ...base, autoApproveRoles: '*' }, 'autoApprove')).toBe(true);
  });
});
