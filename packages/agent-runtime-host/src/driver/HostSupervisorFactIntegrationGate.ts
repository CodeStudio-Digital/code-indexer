import { HostSupervisorFactError } from './HostSupervisorFactError.js';

export const HOST_SUPERVISOR_FACT_INTEGRATION_STATUS = Object.freeze({
  bootstrapToFirstLaunchSameStream: 'present',
  multiLaunchManagementLoop: 'absent',
  crashRecovery: 'absent',
  durableRehydration: 'absent',
  productionReady: false,
} as const);

/**
 * Keeps this protocol slice executable in tests and shadow development while
 * preventing accidental production use before the permanent multi-launch loop,
 * crash recovery, and durable rehydration are implemented.
 */
export function assertHostSupervisorFactIntegrationMode(
  mode: unknown,
): void {
  if (mode !== 'test' && mode !== 'shadow') {
    throw new HostSupervisorFactError(
      'integration_incomplete',
      'an explicit test or shadow mode is required while supervisor fact '
        + 'multi-launch, recovery, and rehydration are absent',
    );
  }
}
