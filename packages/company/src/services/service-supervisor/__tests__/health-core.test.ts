/**
 * Pure tests for the ServiceSupervisor decision core: probe → state
 * transitions, restart backoff (5s/15s/45s), the 3-attempts/10min window,
 * and env-driven policy resolution. No I/O, no fakes needed.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESTART_LIMIT,
  DEFAULT_RESTART_WINDOW_MS,
  decideAction,
  evaluateProbe,
  pruneAttempts,
  resolveRestartPolicy,
  type RestartPolicy,
} from '../health-core.js';

describe('evaluateProbe', () => {
  it('HTTP 2xx–4xx is healthy (dev servers 3xx/4xx on "/")', () => {
    expect(evaluateProbe({ httpStatus: 200 }, 'unknown').next).toBe('healthy');
    expect(evaluateProbe({ httpStatus: 302 }, 'down').next).toBe('healthy');
    expect(evaluateProbe({ httpStatus: 404 }, 'degraded').next).toBe('healthy');
  });

  it('container up but HTTP 5xx is degraded', () => {
    const v = evaluateProbe({ httpStatus: 503, detail: 'HTTP 503' }, 'healthy');
    expect(v.next).toBe('degraded');
    expect(v.changed).toBe(true);
    expect(v.detail).toBe('HTTP 503');
  });

  it('port open but HTTP mute is degraded; port closed is down', () => {
    expect(evaluateProbe({ portListening: true }, 'healthy').next).toBe('degraded');
    expect(evaluateProbe({ portListening: false }, 'healthy').next).toBe('down');
  });

  it('dead container is down regardless of other signals', () => {
    const v = evaluateProbe(
      { containerRunning: false, portListening: true, detail: 'exit=137' },
      'healthy',
    );
    expect(v.next).toBe('down');
  });

  it('an empty outcome (driver hiccup) holds the previous state', () => {
    const v = evaluateProbe({}, 'degraded');
    expect(v.next).toBe('degraded');
    expect(v.changed).toBe(false);
  });

  it('changed is false when the state repeats', () => {
    expect(evaluateProbe({ httpStatus: 200 }, 'healthy').changed).toBe(false);
    expect(evaluateProbe({ httpStatus: 200 }, 'down').changed).toBe(true);
  });
});

describe('resolveRestartPolicy', () => {
  it('defaults: enabled, 3 attempts / 10min, 5s/15s/45s backoff', () => {
    const p = resolveRestartPolicy({} as NodeJS.ProcessEnv);
    expect(p.enabled).toBe(true);
    expect(p.maxAttempts).toBe(DEFAULT_RESTART_LIMIT);
    expect(p.windowMs).toBe(DEFAULT_RESTART_WINDOW_MS);
    expect([...p.backoffMs]).toEqual([5_000, 15_000, 45_000]);
  });

  it('MCP_SERVICE_AUTO_RESTART=0 is the kill-switch; blank stays on', () => {
    expect(resolveRestartPolicy({ MCP_SERVICE_AUTO_RESTART: '0' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveRestartPolicy({ MCP_SERVICE_AUTO_RESTART: 'off' } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(resolveRestartPolicy({ MCP_SERVICE_AUTO_RESTART: '' } as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(resolveRestartPolicy({ MCP_SERVICE_AUTO_RESTART: '1' } as NodeJS.ProcessEnv).enabled).toBe(true);
  });

  it('limit/window envs override; invalid values fall back', () => {
    const p = resolveRestartPolicy({
      MCP_SERVICE_RESTART_LIMIT: '5',
      MCP_SERVICE_RESTART_WINDOW_MS: '60000',
    } as NodeJS.ProcessEnv);
    expect(p.maxAttempts).toBe(5);
    expect(p.windowMs).toBe(60_000);
    const bad = resolveRestartPolicy({
      MCP_SERVICE_RESTART_LIMIT: '-1',
      MCP_SERVICE_RESTART_WINDOW_MS: 'nope',
    } as NodeJS.ProcessEnv);
    expect(bad.maxAttempts).toBe(DEFAULT_RESTART_LIMIT);
    expect(bad.windowMs).toBe(DEFAULT_RESTART_WINDOW_MS);
  });
});

describe('decideAction', () => {
  const policy: RestartPolicy = {
    enabled: true,
    maxAttempts: 3,
    windowMs: 600_000,
    backoffMs: [5_000, 15_000, 45_000],
  };

  it('only down triggers anything — degraded/healthy/unknown are none', () => {
    expect(decideAction('healthy', [], 0, policy)).toBe('none');
    expect(decideAction('degraded', [], 0, policy)).toBe('none');
    expect(decideAction('unknown', [], 0, policy)).toBe('none');
  });

  it('first down restarts immediately', () => {
    expect(decideAction('down', [], 1_000, policy)).toBe('restart');
  });

  it('backoff after the 1st attempt is 5s', () => {
    const attempts = [{ atMs: 10_000 }];
    expect(decideAction('down', attempts, 14_000, policy)).toBe('none');
    expect(decideAction('down', attempts, 15_000, policy)).toBe('restart');
  });

  it('backoff after the 2nd attempt is 15s', () => {
    const attempts = [{ atMs: 0 }, { atMs: 10_000 }];
    expect(decideAction('down', attempts, 24_000, policy)).toBe('none');
    expect(decideAction('down', attempts, 25_000, policy)).toBe('restart');
  });

  it('3 attempts inside the window escalate to incident', () => {
    const attempts = [{ atMs: 0 }, { atMs: 10_000 }, { atMs: 30_000 }];
    expect(decideAction('down', attempts, 100_000, policy)).toBe('incident');
  });

  it('attempts outside the window do not count (recovers to restart)', () => {
    const attempts = [{ atMs: 0 }, { atMs: 10_000 }, { atMs: 30_000 }];
    // 700s later — every attempt fell out of the 600s window.
    expect(decideAction('down', attempts, 700_000, policy)).toBe('restart');
  });

  it('respects a custom maxAttempts', () => {
    const p = { ...policy, maxAttempts: 1 };
    expect(decideAction('down', [{ atMs: 0 }], 60_000, p)).toBe('incident');
  });
});

describe('pruneAttempts', () => {
  it('drops entries older than the window', () => {
    const kept = pruneAttempts(
      [{ atMs: 0 }, { atMs: 500_000 }, { atMs: 590_000 }],
      600_000,
      100_000,
    );
    expect(kept.map((a) => a.atMs)).toEqual([500_000, 590_000]);
  });
});
