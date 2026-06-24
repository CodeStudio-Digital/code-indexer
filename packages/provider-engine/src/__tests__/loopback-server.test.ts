import { describe, it, expect } from 'vitest';
import { startLoopbackServer } from '../oauth/host/loopback-server.js';

/** Real localhost round-trips (deterministic, not flaky) drive the bound server. */
describe('startLoopbackServer (generic authorization-code redirect)', () => {
  it('binds, captures code+state, resolves waitForCode + serves a close-tab page', async () => {
    const lb = await startLoopbackServer({ path: '/cb', expectedState: 'st-1' });
    expect(lb.redirectUri).toMatch(/^http:\/\/localhost:\d+\/cb$/);
    const wait = lb.waitForCode();
    const r = await fetch(`${lb.redirectUri}?code=AUTH&state=st-1`);
    expect(r.status).toBe(200);
    expect(await wait).toEqual({ code: 'AUTH', state: 'st-1' });
    lb.close();
  });

  it('rejects waitForCode on an error redirect', async () => {
    const lb = await startLoopbackServer({ path: '/cb' });
    // Attach the catch BEFORE triggering the rejection (avoid an unhandled
    // rejection in the window between fetch and the assertion).
    const caught = lb.waitForCode().then(() => new Error('unexpected resolve'), (e: Error) => e);
    const r = await fetch(`${lb.redirectUri}?error=access_denied`);
    expect(r.status).toBe(400);
    expect((await caught).message).toMatch(/access_denied/);
    lb.close();
  });

  it('400s + ignores a mismatched state (CSRF guard); times out pending', async () => {
    const lb = await startLoopbackServer({ path: '/cb', expectedState: 'good', timeoutMs: 250 });
    const caught = lb.waitForCode().then(() => new Error('unexpected resolve'), (e: Error) => e);
    const r = await fetch(`${lb.redirectUri}?code=X&state=evil`);
    expect(r.status).toBe(400);
    expect((await caught).message).toMatch(/timeout/);
    lb.close();
  });
});
