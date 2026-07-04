/**
 * Recent-colors MRU in the editor store: setFgColor pushes (deduped, capped),
 * repeats are churn-guarded (no state object churn), swapColors leaves the
 * MRU alone. Pure zustand — node environment.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECENT_COLORS, useSpriteEditorStore } from '../editor-store.js';

const state = () => useSpriteEditorStore.getState();

beforeEach(() => {
  useSpriteEditorStore.setState({ fgColor: '#000000', bgColor: '#ffffff', recentColors: [] });
});

describe('editor-store recentColors', () => {
  it('pushes MRU-first and dedupes re-picks', () => {
    state().setFgColor('#111111');
    state().setFgColor('#222222');
    state().setFgColor('#111111'); // re-pick moves it to the front, no dupe
    expect(state().recentColors).toEqual(['#111111', '#222222']);
    expect(state().fgColor).toBe('#111111');
  });

  it('caps the list at MAX_RECENT_COLORS, dropping the oldest', () => {
    for (let i = 0; i < MAX_RECENT_COLORS + 2; i++) {
      state().setFgColor(`#0000${String(i).padStart(2, '0')}`);
    }
    const recents = state().recentColors;
    expect(recents).toHaveLength(MAX_RECENT_COLORS);
    expect(recents[0]).toBe('#000011'); // newest first
    expect(recents).not.toContain('#000000'); // oldest evicted
    expect(recents).not.toContain('#000001');
  });

  it('churn-guards repeat sets of the current color', () => {
    state().setFgColor('#333333');
    const before = state();
    state().setFgColor('#333333');
    expect(state()).toBe(before); // same state object → no re-render churn
    expect(state().recentColors).toEqual(['#333333']);
  });

  it('swapColors flips fg/bg without touching the MRU', () => {
    state().setFgColor('#444444');
    state().swapColors();
    expect(state().fgColor).toBe('#ffffff');
    expect(state().bgColor).toBe('#444444');
    expect(state().recentColors).toEqual(['#444444']);
  });
});
