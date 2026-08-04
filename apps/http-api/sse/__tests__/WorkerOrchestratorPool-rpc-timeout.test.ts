import { describe, expect, it } from 'vitest';
import {
  resolveCompanyRpcTimeoutMs,
  SANDBOX_PROVISION_RPC_TIMEOUT_MS,
} from '../WorkerOrchestratorPool.js';

describe('company worker RPC timeout policy', () => {
  it('allows the existing ten-minute sandbox provisioning ceiling', () => {
    expect(resolveCompanyRpcTimeoutMs(['addSandboxService']))
      .toBe(SANDBOX_PROVISION_RPC_TIMEOUT_MS);
    expect(SANDBOX_PROVISION_RPC_TIMEOUT_MS).toBe(10 * 60_000);
  });

  it('keeps ordinary RPCs on the bounded default', () => {
    expect(resolveCompanyRpcTimeoutMs(['dispatchCard'])).toBe(60_000);
  });
});
