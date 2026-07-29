import { describe, expect, it, vi } from 'vitest';
import {
  HOST_SUPERVISOR_FACT_INTEGRATION_STATUS,
  assertHostSupervisorFactIntegrationMode,
} from '../driver/HostSupervisorFactIntegrationGate.js';
import {
  harness,
} from './host-supervisor-fact-support.js';

describe('HostSupervisorFact integration gate', () => {
  it('records the first-launch transplant without overstating readiness', () => {
    expect(HOST_SUPERVISOR_FACT_INTEGRATION_STATUS).toEqual({
      bootstrapToFirstLaunchSameStream: 'present',
      multiLaunchManagementLoop: 'absent',
      crashRecovery: 'absent',
      durableRehydration: 'absent',
      productionReady: false,
    });
  });

  it.each([undefined, 'production'])(
    'blocks mode %s before transport or durability',
    (integrationMode) => {
      const durable = { commit: vi.fn(async () => undefined) };
      let transport:
        | import('../ipc/DelimitedByteChannel.js').DelimitedByteChannel
        | undefined;
      expect(() => harness([], durable, {
        observeTransport: (value) => { transport = value; },
        driver: {
          integrationMode,
        } as never,
      })).toThrow(expect.objectContaining({
        code: 'integration_incomplete',
      }));
      expect(durable.commit).not.toHaveBeenCalled();
      expect(transport?.isFailed).toBe(false);
      expect(() => assertHostSupervisorFactIntegrationMode('test'))
        .not.toThrow();
      expect(() => assertHostSupervisorFactIntegrationMode('shadow'))
        .not.toThrow();
    },
  );
});
