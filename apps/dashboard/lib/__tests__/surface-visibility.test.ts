import { describe, expect, it, vi } from 'vitest';
import { visibleStoreSource } from '../surface-visibility.js';

describe('retained surface subscriptions', () => {
  it('releases the visual consumer while hidden and catches up without resetting the source', () => {
    let value = { revision: 1 };
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const read = () => value;
    const notify = vi.fn();
    const active = visibleStoreSource(true, subscribe, read);
    const release = active.subscribe(notify);
    expect(listeners.size).toBe(1);
    // React unsubscribes the old source when its subscribe function changes.
    release();
    const hidden = visibleStoreSource(false, subscribe, read);
    const hiddenSnapshot = hidden.read();
    const releaseHidden = hidden.subscribe(notify);
    for (let i = 0; i < 120; i++) {
      value = { revision: i + 2 };
      for (const listener of listeners) listener();
    }
    expect(listeners.size).toBe(0);
    expect(notify).not.toHaveBeenCalled();
    expect(hidden.read()).toBe(hiddenSnapshot);
    expect(read().revision).toBe(121);
    releaseHidden();
    const revealed = visibleStoreSource(true, subscribe, read);
    const dispose = revealed.subscribe(notify);
    expect(revealed.read()).toBe(value);
    expect(listeners.size).toBe(1);
    dispose();
    dispose();
    expect(listeners.size).toBe(0);
  });

  it('never releases another visible consumer of the same source', () => {
    const listeners = new Set<() => void>();
    const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const read = () => 42;
    const releaseOther = visibleStoreSource(true, subscribe, read).subscribe(vi.fn());
    for (let i = 0; i < 6; i++) {
      const dispose = visibleStoreSource(true, subscribe, read).subscribe(vi.fn());
      expect(listeners.size).toBe(2);
      dispose();
      visibleStoreSource(false, subscribe, read).subscribe(vi.fn())();
      expect(listeners.size).toBe(1);
    }
    releaseOther();
    expect(listeners.size).toBe(0);
  });
});
