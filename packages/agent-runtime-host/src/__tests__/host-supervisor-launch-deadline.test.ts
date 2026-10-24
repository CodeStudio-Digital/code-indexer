import { expect, it } from 'vitest';
import { validateSupervisorLaunch } from '../ipc/HostSupervisorLaunchValidation.js';
import { validateHostSupervisorProvision } from '../ipc/HostSupervisorProvisionValidation.js';
import { MANAGEMENT_CONNECTION } from './host-supervisor-fact-support.js';
import { MANAGEMENT_TOKEN, SUPERVISOR_NONCE, hostSupervisorHello, launchAttempt, launchOptions } from './host-supervisor-bootstrap-support.js';

function launch(timeout?: number, lease = 60_000n) {
  const hello = hostSupervisorHello();
  hello.frameLimits!.writeTimeoutMs = 2_000n;
  const { policy } = validateHostSupervisorProvision({ hostHello: hello,
    expectedConnectionId: MANAGEMENT_CONNECTION, expectedManagementSessionToken: MANAGEMENT_TOKEN,
    expectedSupervisorLaunchNonce: SUPERVISOR_NONCE, nowUnixMs: () => 100n });
  return validateSupervisorLaunch(launchAttempt({ authorityLeaseExpiresAtUnixMs: lease }), policy,
    launchOptions({ launchResponseTimeoutMs: timeout, responseTimeoutMs: 2_000 }), 100n, 'hello', 'launch');
}

it('allows cold physical launch to outlive the 2s command and frame-write bound', () => {
  expect(launch(30_000).deadlineAtUnixMs).toBe(30_100n);
  expect(launch().deadlineAtUnixMs).toBe(2_100n);
});

it('never extends the admitted lease while waiting for physical startup', () => {
  expect(launch(30_000, 5_000n).deadlineAtUnixMs).toBe(5_000n);
  expect(launch(undefined, 1_000n).deadlineAtUnixMs).toBe(1_000n);
});

it.each([0, -1, 60_001, 1.5, NaN, Infinity])('rejects unbounded launch timeout %s', timeout => {
  expect(() => launch(timeout)).toThrow(expect.objectContaining({ code: 'invalid_launch' }));
});
