import { describe, expect, it, vi } from 'vitest';
import type { ControlPlaneRunContext } from '@mcp/store/control-plane/index.js';
import type { FileControlPlaneAuthority } from '../../file-control-plane-store.js';
import { admitWorkerAttempt, type WorkerAttemptOwner } from '../coder-attempt-bridge.js';

function fixture() {
  const context = { sessionId: 'session', agentRunId: 'run' } as ControlPlaneRunContext;
  const owner: WorkerAttemptOwner = { currentRunId: 1, runInProgress: true, controlPlaneRunContext: context };
  const admission = vi.fn(async () => ({ ok: true }));
  const activate = vi.fn(async () => undefined);
  const store = { admitCoderAttempt: admission, markRunStarted: activate } as unknown as FileControlPlaneAuthority;
  const payload = { runId: 1, preparation: { sessionId: 'session', agentRunId: 'run', runnerRunId: 'runner-1' } };
  return { context, owner, admission, activate, store, payload };
}

describe('attempt admission worker bridge', () => {
  it('uses the host fence and refuses stale or foreign worker requests before persistence', async () => {
    const f = fixture();
    await expect(admitWorkerAttempt(f.payload, () => f.owner, f.store)).resolves.toEqual({ ok: true });
    expect(f.admission).toHaveBeenCalledWith(f.context, f.payload.preparation);
    expect(f.activate).toHaveBeenCalledWith(f.context, 'runner-1');
    await expect(admitWorkerAttempt({ ...f.payload, runId: 2 }, () => f.owner, f.store)).rejects.toThrow('stale');
    await expect(admitWorkerAttempt({ ...f.payload, preparation: { sessionId: 'other' } }, () => f.owner, f.store))
      .rejects.toThrow('different run');
    expect(f.admission).toHaveBeenCalledOnce();
  });

  it('does not return a committed receipt to a worker replaced or cancelled during disk I/O', async () => {
    const f = fixture();
    f.admission.mockImplementation(async () => {
      f.owner.controlPlaneRunContext = null;
      return { ok: true };
    });
    await expect(admitWorkerAttempt(f.payload, () => f.owner, f.store)).rejects.toThrow('stale');
    expect(f.activate).not.toHaveBeenCalled();
    await expect(admitWorkerAttempt(f.payload, () => f.owner, undefined)).rejects.toThrow('unavailable');
  });

  it('never returns an execution receipt if durable activation fails', async () => {
    const f = fixture();
    f.activate.mockRejectedValueOnce(new Error('activation disk full'));
    await expect(admitWorkerAttempt(f.payload, () => f.owner, f.store)).rejects.toThrow('activation disk full');
  });
});
