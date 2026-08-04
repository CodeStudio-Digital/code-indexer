import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  brokerRouteReadiness,
  refreshGlobalMcpExternalPool,
} from '../mcp-servers.routes.js';
import { setGlobalMcpExternalPool } from '../../sse/McpExternalPool.js';

afterEach(() => setGlobalMcpExternalPool(null));

describe('Unity broker route readiness', () => {
  it('does not confuse a persisted tool catalogue with a live Unity route', () => {
    expect(brokerRouteReadiness({
      bridgeConnected: false,
      bridgeState: 'offline',
      routeReady: false,
    })).toEqual({
      ready: false,
      error: 'Unity broker is online, but no Unity bridge is connected.',
    });
  });

  it('accepts a connected ready active route', () => {
    expect(brokerRouteReadiness({
      bridgeConnected: true,
      bridgeState: 'ready',
      routeReady: true,
    })).toEqual({ ready: true });
  });

  it('refreshes the shared runtime catalogue after an admin mutation/test', async () => {
    const refresh = vi.fn(async () => undefined);
    setGlobalMcpExternalPool({ refresh } as never);

    await refreshGlobalMcpExternalPool();

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
