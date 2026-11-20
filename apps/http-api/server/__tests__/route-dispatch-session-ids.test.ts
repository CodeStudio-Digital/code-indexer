import { describe, expect, it } from 'vitest';
import { DISPATCH_TABLE } from '../route-dispatch.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';

describe('IPC session route dispatch', () => {
  it('keeps coder and Company session UUIDs opaque in route paths', () => {
    expect(
      DISPATCH_TABLE['coder.stream.sendMessage'].url({
        sessionId: SESSION_ID.toUpperCase(),
      }),
    ).toBe(`/api/coder/sessions/${SESSION_ID}/messages`);
    expect(
      DISPATCH_TABLE['company.sessions.get'].url({ id: SESSION_ID }),
    ).toBe(`/api/company/sessions/${SESSION_ID}`);
    expect(
      DISPATCH_TABLE['company.stream'].url({
        sessionId: SESSION_ID,
        since: 12,
      }),
    ).toBe(`/api/company/sessions/${SESSION_ID}/stream?since=12`);
  });

  it('uses the filesystem Company update method and rejects legacy numbers', () => {
    expect(DISPATCH_TABLE['company.sessions.update'].method).toBe('PATCH');
    expect(() =>
      DISPATCH_TABLE['coder.stream.attach'].url({ sessionId: 7 }),
    ).toThrow(/canonical UUID/);
    expect(() =>
      DISPATCH_TABLE['company.sessions.delete'].url({ id: '7' }),
    ).toThrow(/canonical UUID/);
  });
});
