import { describe, expect, it, vi } from 'vitest';
import { asCompanySessionId } from '@mcp/session-storage';
import { readSupervisorStatus } from '../supervisor-status.js';

describe('supervisor availability', () => {
  const one = asCompanySessionId('00000000-0000-4000-8000-000000000001');
  const two = asCompanySessionId('00000000-0000-4000-8000-000000000002');
  it('distinguishes idle, disabled and broken worker instead of healthy empty data', async () => {
    const supervisorRpc = vi.fn(async () => null);
    const pool = { activeSessionIds: () => [one], supervisorRpc };
    expect(await readSupervisorStatus(pool, two)).toMatchObject({ availability: 'idle', sessions: [] });
    expect(supervisorRpc).not.toHaveBeenCalled();
    expect(await readSupervisorStatus(pool, one)).toMatchObject({ availability: 'disabled', enabled: false });
    supervisorRpc.mockRejectedValueOnce(new Error('worker disconnected'));
    expect(await readSupervisorStatus(pool, one)).toMatchObject({ availability: 'unavailable' });
    expect(await readSupervisorStatus(pool, one, false)).toMatchObject({ enabled: false, availability: 'disabled' });
  });
  it('only asks the selected worker and reports stopped timers as unavailable', async () => {
    const supervisorRpc = vi.fn(async () => ({ isRunning: true }));
    const pool = { activeSessionIds: () => [one, two], supervisorRpc };
    expect(await readSupervisorStatus(pool, two)).toMatchObject({ availability: 'active', sessions: [{ sessionId: two }] });
    expect(supervisorRpc).toHaveBeenCalledExactlyOnceWith(two, 'getStatus');
    supervisorRpc.mockResolvedValueOnce({ isRunning: false });
    expect(await readSupervisorStatus(pool, one)).toMatchObject({ availability: 'unavailable' });
  });
});
