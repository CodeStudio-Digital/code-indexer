import { describe, it, expect } from 'vitest';
import { CompanyOrchestrator } from '@mcp/company/orchestrator.js';

// Regression for the worker-proxy serialization bug: `GET /state-snapshot`
// used to read `orchestrator.isMasterAlive` / `.masterEndedAt` directly off
// the worker-backed proxy, where a property GET returns a nested proxy (not a
// value) and `c.json` → `JSON.stringify` then dispatched a bogus `.toJSON`
// RPC. The route now goes through `getMasterStatus()`, which MUST return a
// plain JSON-/structured-clone-safe POJO so it survives the worker→main hop
// and `c.json`.
//
// `getMasterStatus` only reads the two getters, so we exercise it against a
// minimal `this` via the prototype — no need to build a full orchestrator.
function callGetMasterStatus(self: { isMasterAlive: boolean; masterEndedAt: string | null }) {
  return CompanyOrchestrator.prototype.getMasterStatus.call(self as never);
}

describe('CompanyOrchestrator.getMasterStatus', () => {
  it('returns a plain {alive,endedAt} POJO for a live master', async () => {
    const result = await callGetMasterStatus({ isMasterAlive: true, masterEndedAt: '2026-01-01T00:00:00.000Z' });
    expect(result).toEqual({ alive: true, endedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('reflects the standby/never-started case (alive false, endedAt null)', async () => {
    const result = await callGetMasterStatus({ isMasterAlive: false, masterEndedAt: null });
    expect(result).toEqual({ alive: false, endedAt: null });
  });

  it('result is JSON-/clone-safe (no proxies, no functions) — survives c.json', async () => {
    const result = await callGetMasterStatus({ isMasterAlive: true, masterEndedAt: null });
    // The crux of the bug: the value the route serializes must round-trip
    // through JSON unchanged (a proxy would throw / serialize to garbage).
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(typeof result).toBe('object');
    for (const v of Object.values(result)) {
      expect(typeof v).not.toBe('function');
    }
  });
});
