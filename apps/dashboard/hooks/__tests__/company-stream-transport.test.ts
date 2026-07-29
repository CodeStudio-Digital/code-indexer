import { describe, expect, it, vi } from 'vitest';
import {
  advanceCompanyStreamCursor,
  createCompanyStreamEventPump,
  disposeCompanyStreamLifecycle,
  isCompanyStreamOwner,
  resolveCompanyStreamTransport,
} from '../useCompanyStream.js';

describe('resolveCompanyStreamTransport', () => {
  it('routes the App surface exclusively through its App-owned facade', () => {
    const companySessionId = '0000005a-0000-4000-8000-000000000000';
    const appSessionId = '00000007-0000-4000-8000-000000000000';
    expect(resolveCompanyStreamTransport(companySessionId, {
      kind: 'app_studio',
      appSessionId,
    })).toEqual({
      basePath: `/api/app-studio/apps/${appSessionId}/team/commands`,
      statePath: '/state',
      includeKanban: false,
      allowDirectAgentControls: false,
      allowRuntimeSwitch: false,
      keepAttachedWhileOrchestratorLive: true,
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
      keepAttachedWhileOrchestratorLive: false,
    });
  });

  it('invalidates and aborts an App stream when its rail unmounts', () => {
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
