import { describe, expect, it } from 'vitest';
import {
  registerPluginFrame,
  resolveFrame,
  unregisterPluginFrame,
} from '../webview-frame-registry.js';

const fakeWin = () => ({}) as unknown as MessageEventSource;

describe('resolveFrame (frame-registration grace)', () => {
  it('resolves immediately when the frame is already registered', async () => {
    const w = fakeWin();
    registerPluginFrame(w, { namespace: 'p', projectId: 1 });
    expect(await resolveFrame(w)).toEqual({ namespace: 'p', projectId: 1 });
    unregisterPluginFrame(w);
  });

  it('tolerates a brief registration lag via one delayed retry', async () => {
    const w = fakeWin();
    setTimeout(() => registerPluginFrame(w, { namespace: 'late' }), 20);
    // Registered within the ~60ms grace window → resolves rather than erroring.
    expect(await resolveFrame(w)).toEqual({ namespace: 'late' });
    unregisterPluginFrame(w);
  });

  it('returns null when the frame never registers', async () => {
    expect(await resolveFrame(fakeWin())).toBeNull();
  });
});
