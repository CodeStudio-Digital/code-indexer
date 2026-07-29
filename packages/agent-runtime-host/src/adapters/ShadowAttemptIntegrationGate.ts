import {
  assertHostSupervisorFactIntegrationMode,
} from '../driver/HostSupervisorFactIntegrationGate.js';
import { AttemptControlAdapterError } from './AttemptControlAdapterError.js';

export function assertShadowAttemptIntegrationMode(mode: unknown): void {
  try {
    assertHostSupervisorFactIntegrationMode(mode);
  } catch (cause) {
    throw new AttemptControlAdapterError(
      'invalid_provision',
      'physical attempt channels are restricted to test or shadow mode',
      { cause },
    );
  }
}
