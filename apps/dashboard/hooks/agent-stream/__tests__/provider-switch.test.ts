import { describe, expect, it, vi } from 'vitest';
import { ProviderSwitchCoordinator } from '../provider-switch.js';

const selection = (provider: string) => ({ provider, model: `${provider}-model` });
function deferred() {
  let resolve!: (value: ReturnType<typeof selection>) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<ReturnType<typeof selection>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('per-session provider switch ordering', () => {
  it('serializes rapid selections and a waiting send follows the newest choice', async () => {
    const store = new ProviderSwitchCoordinator(), first = deferred(), second = deferred();
    const write1 = vi.fn(() => first.promise), write2 = vi.fn(() => second.promise);
    const one = store.change('a', selection('first'), write1);
    const sent = vi.fn();
    const waiting = store.wait('a').then(sent);
    const two = store.change('a', selection('last'), write2);
    await vi.waitFor(() => expect(write1).toHaveBeenCalledOnce());
    expect(write2).not.toHaveBeenCalled();
    first.resolve(selection('first'));
    await one;
    await vi.waitFor(() => expect(write2).toHaveBeenCalledOnce());
    expect(sent).not.toHaveBeenCalled();
    expect(store.snapshot('a')).toMatchObject({ selection: selection('last'), pending: true });
    second.resolve(selection('last'));
    await Promise.all([two, waiting]);
    expect(sent).toHaveBeenCalledOnce();
    expect(store.snapshot('a')).toEqual({ selection: selection('last'), pending: false, error: null });
  });

  it('does not let an old failure override a newer successful selection or another session', async () => {
    const store = new ProviderSwitchCoordinator(), first = deferred();
    const one = store.change('a', selection('old'), () => first.promise);
    const failed = expect(one).rejects.toThrow('first failed');
    const two = store.change('a', selection('new'), async () => selection('new'));
    await store.change('b', selection('independent'), async () => selection('independent'));
    await store.wait('b');
    const waiting = store.wait('a');
    first.reject(new Error('first failed'));
    await Promise.all([failed, two, waiting]);
    expect(store.snapshot('a')?.selection.provider).toBe('new');
    expect(store.snapshot('b')?.selection.provider).toBe('independent');
  });
});
