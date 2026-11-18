import type { SystemApi } from '@mcp/api-bus';
import type { HandlerDeps } from '../types.js';
import { getPreflight } from './preflight.js';
import { machineSetupStream } from './machine-setup.js';

/**
 * `system` namespace handlers — first-run preflight + guided Podman machine
 * setup. `podmanMachineSetupStream` ends in `Stream`, so the IPC bridge binds
 * it as a MessagePort stream automatically (no preload/route changes).
 */
export function createSystemHandlers(deps: HandlerDeps): SystemApi {
  let pendingPreflight: ReturnType<typeof getPreflight> | undefined;
  return {
    preflight: () => pendingPreflight ??= getPreflight(deps).finally(() => { pendingPreflight = undefined; }),
    podmanMachineSetupStream: (_input, ctx) => machineSetupStream(ctx?.signal),
  };
}
