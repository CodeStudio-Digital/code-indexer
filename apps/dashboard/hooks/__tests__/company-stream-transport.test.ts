import { describe, expect, it, vi } from 'vitest';
import {
  advanceCompanyStreamCursor,
  beginCompanyStreamRequest,
  createCompanyStreamEventPump,
  disposeCompanyStreamLifecycle,
  isCompanyStreamOwner,
  resolveCompanyStreamTransport,
  unconfirmedCompanyLiveness,
} from '../useCompanyStream.js';

describe('resolveCompanyStreamTransport', () => {
  it('invalidates an older preflight and final hydration when another intent starts in the same mount', async () => {
    const lifecycle = { current: 1 }, requests = { current: 0 };
    const controller = { current: new AbortController() as AbortController | null };
    const aborted = controller.current!;
    const previous = beginCompanyStreamRequest(lifecycle, requests, controller);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const hydrate = vi.fn();
    const lateResponse = pending.then(() => { if (previous()) hydrate(); });
    const replacement = beginCompanyStreamRequest(lifecycle, requests, controller);
    finish(); await lateResponse;
    expect(aborted.signal.aborted).toBe(true);
    expect(previous()).toBe(false);
    expect(replacement()).toBe(true);
    expect(hydrate).not.toHaveBeenCalled();
  });

  it('keeps a late resumed response from opening a stream after unmount', () => {
    const mounted = { current: false };
    const current = beginCompanyStreamRequest({ current: 2 }, { current: 5 }, { current: null }, mounted);
    expect(current()).toBe(false);
  });

  it('clears unconfirmed/failed start liveness while preserving the pending inbox', () => {
    expect(unconfirmedCompanyLiveness({ pendingMasterInboxCount: 3 })).toEqual({
      masterAlive: false, liveOrchestrator: false, pendingMasterInboxCount: 3,
    });
  });
  it('preserves the generic Company transport for Company mode', () => {
    const companySessionId = '0000005a-0000-4000-8000-000000000000';
    expect(resolveCompanyStreamTransport(companySessionId)).toEqual({
      basePath: `/api/company/sessions/${companySessionId}`,
      statePath: '',
      includeKanban: true,
      allowDirectAgentControls: true,
      allowRuntimeSwitch: true,
      keepAttachedWhileOrchestratorLive: true,
    });
  });

  it('invalidates and aborts a Company stream when its rail unmounts', () => {
    const abort = vi.fn();
    const lifecycle = { current: 4 };
    const controller: { current: AbortController | null } = {
      current: { abort } as unknown as AbortController,
    };

    disposeCompanyStreamLifecycle(lifecycle, controller, 4);

    expect(lifecycle.current).toBe(5);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(controller.current).toBeNull();
  });

  it('does not let stale lifecycle cleanup abort a replacement stream', () => {
    const abort = vi.fn();
    const lifecycle = { current: 5 };
    const controller: { current: AbortController | null } = {
      current: { abort } as unknown as AbortController,
    };

    disposeCompanyStreamLifecycle(lifecycle, controller, 4);

    expect(lifecycle.current).toBe(5);
    expect(abort).not.toHaveBeenCalled();
    expect(controller.current).not.toBeNull();
  });

  it('pairs the Company replay cursor with its bus and resets on bus change', () => {
    const oldCursor = { seq: 42, busId: 'old-bus' };
    const switched = advanceCompanyStreamCursor(
      oldCursor,
      { event: 'bus_info', data: '', id: undefined },
      { bus_id: 'new-bus' },
    );
    expect(switched).toEqual({ seq: -1, busId: 'new-bus' });

    const advanced = advanceCompanyStreamCursor(
      switched,
      { event: 'agent_status', data: '{}', id: 0 },
      {},
    );
    expect(advanced).toEqual({ seq: 0, busId: 'new-bus' });
  });

  it('drains replay bursts in strict ordered batches with event-loop yields', async () => {
    const seen: number[] = [];
    let yields = 0;
    const pump = createCompanyStreamEventPump({
      isActive: () => true,
      batchSize: 50,
      yieldTurn: async () => {
        yields += 1;
        await Promise.resolve();
      },
      processEvent: (event) => {
        if (typeof event.id === 'number') seen.push(event.id);
      },
    });

    for (let id = 0; id < 122; id += 1) {
      pump.enqueue({ id, event: 'agent_event', data: '{}' });
    }
    await pump.flush();

    expect(seen).toEqual(Array.from({ length: 122 }, (_, id) => id));
    expect(yields).toBe(3);
  });

  it('drops late events and teardown from a superseded Company stream', async () => {
    const lifecycle = { current: 7 };
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const activeController: { current: AbortController | null } = {
      current: controllerA,
    };
    let cursor = -1;
    const connectedWrites: boolean[] = [];
    let releaseYield!: () => void;
    const pumpA = createCompanyStreamEventPump({
      isActive: () => isCompanyStreamOwner(
        lifecycle,
        activeController,
        7,
        controllerA,
      ),
      yieldTurn: () => new Promise<void>((resolve) => {
        releaseYield = resolve;
      }),
      processEvent: (event) => {
        cursor = event.id ?? cursor;
      },
    });

    pumpA.enqueue({ id: 1, event: 'agent_event', data: '{}' });
    activeController.current = controllerB;
    controllerA.abort();
    pumpA.enqueue({ id: 2, event: 'agent_event', data: '{}' });
    releaseYield();
    await pumpA.flush();

    if (isCompanyStreamOwner(lifecycle, activeController, 7, controllerA)) {
      connectedWrites.push(false);
    }

    expect(cursor).toBe(-1);
    expect(connectedWrites).toEqual([]);
    expect(isCompanyStreamOwner(lifecycle, activeController, 7, controllerB)).toBe(true);
  });
});
