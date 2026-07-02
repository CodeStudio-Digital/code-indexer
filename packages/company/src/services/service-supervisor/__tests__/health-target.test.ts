/**
 * health-target tests (B8) — pure probe logic for HOST processes, with
 * fake IO (no real sockets/PIDs except one `isPidAlive(process.pid)`
 * sanity check). Verdict mapping is asserted through `evaluateProbe` so
 * the reuse of `containerRunning` as generic unit-liveness stays covered.
 */
import { describe, expect, it } from 'vitest';
import {
  isPidAlive,
  localServiceId,
  probeHealthTarget,
  probeLocalProcess,
  type LocalProbeIo,
} from '../health-target.js';
import { evaluateProbe } from '../health-core.js';

function io(over: Partial<LocalProbeIo> = {}): LocalProbeIo {
  return {
    probeHttp: async () => ({ replied: false, status: 0 }),
    isPortListening: async () => false,
    isPidAlive: () => true,
    ...over,
  };
}

describe('localServiceId', () => {
  it('prefixes the session id', () => {
    expect(localServiceId(12)).toBe('local:12');
  });
});

describe('probeLocalProcess', () => {
  it('an HTTP reply short-circuits: any status is an answer', async () => {
    const outcome = await probeLocalProcess(
      { hostPort: 3000, pid: 42 },
      io({ probeHttp: async () => ({ replied: true, status: 200 }) }),
    );
    expect(outcome).toEqual({ httpStatus: 200 });
    expect(evaluateProbe(outcome, 'unknown').next).toBe('healthy');
  });

  it('HTTP 5xx carries the status as detail and maps to degraded', async () => {
    const outcome = await probeLocalProcess(
      { hostPort: 3000, pid: 42 },
      io({ probeHttp: async () => ({ replied: true, status: 503 }) }),
    );
    expect(outcome).toEqual({ httpStatus: 503, detail: 'HTTP 503' });
    expect(evaluateProbe(outcome, 'unknown').next).toBe('degraded');
  });

  it('no HTTP + port listening + pid alive ⇒ degraded (app wedged)', async () => {
    const outcome = await probeLocalProcess(
      { hostPort: 3000, pid: 42 },
      io({ isPortListening: async () => true }),
    );
    expect(outcome.portListening).toBe(true);
    expect(outcome.containerRunning).toBe(true);
    expect(evaluateProbe(outcome, 'unknown').next).toBe('degraded');
  });

  it('dead pid ⇒ down with a process detail', async () => {
    const outcome = await probeLocalProcess(
      { hostPort: 3000, pid: 42 },
      io({ isPidAlive: () => false }),
    );
    expect(outcome.containerRunning).toBe(false);
    expect(outcome.detail).toBe('process 42 not running');
    expect(evaluateProbe(outcome, 'unknown').next).toBe('down');
  });

  it('hostPort 0 skips HTTP/TCP entirely and relies on the pid channel', async () => {
    let httpCalled = false;
    const outcome = await probeLocalProcess(
      { hostPort: 0, pid: 42 },
      io({
        probeHttp: async () => {
          httpCalled = true;
          return { replied: true, status: 200 };
        },
        isPidAlive: () => false,
      }),
    );
    expect(httpCalled).toBe(false);
    expect(outcome).toEqual({ containerRunning: false, detail: 'process 42 not running' });
  });

  it('no pid + closed port ⇒ down with the port detail', async () => {
    const outcome = await probeLocalProcess({ hostPort: 3000, pid: null }, io());
    expect(outcome.portListening).toBe(false);
    expect(outcome.containerRunning).toBeUndefined();
    expect(outcome.detail).toBe('port 3000 not listening');
    expect(evaluateProbe(outcome, 'unknown').next).toBe('down');
  });

  it('throwing IO learns nothing — evaluateProbe holds the previous state', async () => {
    const outcome = await probeLocalProcess(
      { hostPort: 3000, pid: 42 },
      {
        probeHttp: async () => {
          throw new Error('boom');
        },
        isPortListening: async () => {
          throw new Error('boom');
        },
        isPidAlive: () => {
          throw new Error('boom');
        },
      },
    );
    expect(outcome).toEqual({});
    expect(evaluateProbe(outcome, 'healthy').next).toBe('healthy');
  });
});

describe('probeHealthTarget', () => {
  it('container target without a driver learns nothing (holds state)', async () => {
    const outcome = await probeHealthTarget({
      kind: 'container',
      serviceId: 'api',
      hostPort: 3000,
      containerId: 'c-1',
    });
    expect(outcome).toEqual({});
  });

  it('local target dispatches to the local probe with the injected IO', async () => {
    const outcome = await probeHealthTarget(
      { kind: 'local', serviceId: 'local:12', hostPort: 3000, pid: 42 },
      { local: io({ probeHttp: async () => ({ replied: true, status: 200 }) }) },
    );
    expect(outcome).toEqual({ httpStatus: 200 });
  });
});

describe('isPidAlive', () => {
  it('reports the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
});
