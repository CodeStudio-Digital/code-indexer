import { OwnedAttemptAdapter, type AttemptRuntimeLauncher } from './OwnedAttemptAdapter.js';

/** The product supplies its existing worker launch/cancel lease. Provider,
 * credentials, permissions and transport events remain owned by that worker. */
export class LegacyAgentRuntimeAdapter extends OwnedAttemptAdapter {
  constructor(launcher: AttemptRuntimeLauncher, maximumAttempts?: number) {
    super('legacy_ts', launcher, maximumAttempts);
  }
}
