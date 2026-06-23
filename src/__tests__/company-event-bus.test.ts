import { describe, it, expect, vi } from 'vitest';
import { CompanyEventBus, type CompanyInternalEvent } from '@mcp/company/services/CompanyEventBus.js';
import { IdleController } from '@mcp/company/services/IdleController.js';

describe('CompanyEventBus — primitive pub/sub', () => {
  it('starts with zero subscribers on every channel', () => {
    const bus = new CompanyEventBus();
    expect(bus.listenerCount('master.ended')).toBe(0);
    expect(bus.listenerCount('master.resurrected')).toBe(0);
    expect(bus.listenerCount('subordinates.changed')).toBe(0);
    expect(bus.listenerCount('user.message_received')).toBe(0);
  });

  it('delivers an event to its single subscriber', () => {
    const bus = new CompanyEventBus();
    const handler = vi.fn();
    bus.on('master.ended', handler);
    bus.emit({ type: 'master.ended' });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith({ type: 'master.ended' });
  });

  it('delivers an event to every subscriber in subscription order', () => {
    const bus = new CompanyEventBus();
    const order: number[] = [];
    bus.on('subordinates.changed', () => order.push(1));
    bus.on('subordinates.changed', () => order.push(2));
    bus.on('subordinates.changed', () => order.push(3));
    bus.emit({ type: 'subordinates.changed' });
    expect(order).toEqual([1, 2, 3]);
  });

  it('routes events only to subscribers of that channel', () => {
    const bus = new CompanyEventBus();
    const ended = vi.fn();
    const changed = vi.fn();
    bus.on('master.ended', ended);
    bus.on('subordinates.changed', changed);
    bus.emit({ type: 'master.ended' });
    expect(ended).toHaveBeenCalledOnce();
    expect(changed).not.toHaveBeenCalled();
  });

  it('an unsubscribe function detaches just one handler', () => {
    const bus = new CompanyEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.on('master.ended', a);
    bus.on('master.ended', b);
    offA();
    bus.emit({ type: 'master.ended' });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledOnce();
  });

  it('listenerCount tracks adds and removes', () => {
    const bus = new CompanyEventBus();
    const off1 = bus.on('master.ended', () => undefined);
    const off2 = bus.on('master.ended', () => undefined);
    expect(bus.listenerCount('master.ended')).toBe(2);
    off1();
    expect(bus.listenerCount('master.ended')).toBe(1);
    off2();
    expect(bus.listenerCount('master.ended')).toBe(0);
  });

  it('handler that throws does not stop the next handler', () => {
    const bus = new CompanyEventBus();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const after = vi.fn();
    bus.on('master.ended', () => { throw new Error('boom'); });
    bus.on('master.ended', after);
    bus.emit({ type: 'master.ended' });
    expect(after).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('emit with no subscribers is a no-op (does not throw)', () => {
    const bus = new CompanyEventBus();
    expect(() => bus.emit({ type: 'user.message_received' })).not.toThrow();
  });

  it('idempotent unsubscribe — calling off() twice is safe', () => {
    const bus = new CompanyEventBus();
    const off = bus.on('master.ended', () => undefined);
    off();
    expect(() => off()).not.toThrow();
    expect(bus.listenerCount('master.ended')).toBe(0);
  });
});

// ─── End-to-end: bus → IdleController ────────────────────────────

function makeIdleHarness(overrides?: {
  hasEnded?: boolean;
  endedWithError?: string | null;
  runningCount?: number;
  consumeMasterShouldContinue?: () => boolean;
  onAutoContinue?: () => void;
}) {
  const bus = new CompanyEventBus();
  const publish = vi.fn();
  const markEnded = vi.fn();
  const updateStatus = vi.fn();
  const onAutoContinue = overrides?.onAutoContinue ?? vi.fn();
  const consumeMasterShouldContinue =
    overrides?.consumeMasterShouldContinue ?? (() => false);

  const idle = new IdleController({
    ctx: {
      companySessionId: 42,
      companyStore: { updateCompanySessionStatus: updateStatus },
      isAborted: false,
      isBusEnded: false,
    } as never,
    bus: { publish, markEnded } as never,
    eventBus: bus,
    subordinates: { runningCount: overrides?.runningCount ?? 0 } as never,
    master: {
      hasEnded: overrides?.hasEnded ?? false,
      endedWithError: overrides?.endedWithError ?? null,
    },
    consumeMasterShouldContinue,
    onAutoContinue,
  });
  return { idle, bus, publish, markEnded, updateStatus, onAutoContinue };
}

describe('CompanyEventBus + IdleController integration', () => {
  it('master.ended via bus triggers checkIdle (publishes session_idle when no running subs)', () => {
    const { bus, publish } = makeIdleHarness({ hasEnded: true, runningCount: 0 });
    bus.emit({ type: 'master.ended' });
    expect(publish).toHaveBeenCalledWith('session_idle', { reason: 'waiting_for_input' });
  });

  it('master.ended does NOT publish session_idle when subordinates still running', () => {
    const { bus, publish } = makeIdleHarness({ hasEnded: true, runningCount: 2 });
    bus.emit({ type: 'master.ended' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('subordinates.changed via bus triggers checkIdle just like master.ended', () => {
    const { bus, publish } = makeIdleHarness({ hasEnded: true, runningCount: 0 });
    bus.emit({ type: 'subordinates.changed' });
    expect(publish).toHaveBeenCalledWith('session_idle', { reason: 'waiting_for_input' });
  });

  it('master.resurrected via bus cancels the idle timer (clear()) — no publish', () => {
    const { bus, publish } = makeIdleHarness({ hasEnded: false });
    bus.emit({ type: 'master.resurrected' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('user.message_received via bus is also a clear() signal', () => {
    const { bus, publish } = makeIdleHarness({ hasEnded: false });
    bus.emit({ type: 'user.message_received' });
    expect(publish).not.toHaveBeenCalled();
  });

  it('master.ended with endedWithError publishes session_idle with master_error reason', () => {
    const { bus, publish } = makeIdleHarness({
      hasEnded: true,
      endedWithError: 'aborted',
      runningCount: 0,
    });
    bus.emit({ type: 'master.ended' });
    expect(publish).toHaveBeenCalledWith('session_idle', {
      reason: 'master_error',
      errorDetail: 'aborted',
    });
  });

  it('consumeMasterShouldContinue=true triggers onAutoContinue instead of session_idle', () => {
    const onAutoContinue = vi.fn();
    const { bus, publish } = makeIdleHarness({
      hasEnded: true,
      runningCount: 0,
      consumeMasterShouldContinue: () => true,
      onAutoContinue,
    });
    bus.emit({ type: 'master.ended' });
    expect(onAutoContinue).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
  });

  it('updates session status to "paused" when transitioning to idle', () => {
    const { bus, updateStatus } = makeIdleHarness({ hasEnded: true, runningCount: 0 });
    bus.emit({ type: 'master.ended' });
    expect(updateStatus).toHaveBeenCalledWith(42, 'paused');
  });

  it('dispose() removes all bus subscriptions', () => {
    const { idle, bus, publish } = makeIdleHarness({ hasEnded: true, runningCount: 0 });
    idle.dispose();
    bus.emit({ type: 'master.ended' });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('CompanyEventBus event type coverage', () => {
  // Sanity check that every event type used in production code paths
  // has a discrete entry in the union and the bus accepts it. This
  // catches typos in event names during refactors.
  const types: Array<CompanyInternalEvent['type']> = [
    'master.ended',
    'master.resurrected',
    'user.message_received',
    'subordinates.changed',
  ];
  for (const type of types) {
    it(`accepts '${type}' as a valid event type`, () => {
      const bus = new CompanyEventBus();
      const handler = vi.fn();
      bus.on(type, handler);
      bus.emit({ type } as CompanyInternalEvent);
      expect(handler).toHaveBeenCalledWith({ type });
    });
  }
});
