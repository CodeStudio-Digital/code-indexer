import { describe, expect, it } from 'vitest';
import { brokerRouteReadiness } from '../mcp-servers.routes.js';

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
});
