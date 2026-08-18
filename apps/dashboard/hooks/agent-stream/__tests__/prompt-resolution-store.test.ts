import { afterEach, describe, expect, it } from 'vitest';
import {
  clearPromptResolution,
  getPromptDraft,
  getPromptResolution,
  isPromptResolved,
  markPromptResolved,
  resetPromptResolutions,
  setPromptDraft,
  subscribePromptResolutions,
} from '../prompt-resolution-store.js';

afterEach(() => resetPromptResolutions());

describe('prompt resolution store', () => {
  it('returns an answer by the id that recorded it', () => {
    markPromptResolved({ id: 'q_live', resolution: 'Option A' });

    expect(getPromptResolution('q_live')).toBe('Option A');
    expect(isPromptResolved('q_live')).toBe(true);
    expect(isPromptResolved('q_other')).toBe(false);
  });

  it('bridges a live card to its persisted twin through the signature', () => {
    // The two sides never share an id: runtime `q_…` versus provider `toolu_…`.
    markPromptResolved({ id: 'q_live', signature: 'sig-abc', sessionId: '7', resolution: 'yes' });

    expect(getPromptResolution('toolu_persisted', 'sig-abc', '7')).toBe('yes');
    // Session-agnostic fallback for call sites that lack the session id.
    expect(getPromptResolution('toolu_persisted', 'sig-abc')).toBe('yes');
    expect(getPromptResolution('toolu_persisted', 'other-sig')).toBeUndefined();
  });

  it('keeps structured answers intact, not just strings', () => {
    const answers = { strategy: { selected: ['incremental'], freeform: 'go slow' } };
    markPromptResolved({ id: 'dg_1', resolution: answers });

    expect(getPromptResolution('dg_1')).toEqual(answers);
  });

  it('undoes an optimistic resolution when the transport failed', () => {
    markPromptResolved({ id: 'pl_1', signature: 'sig-plan', resolution: 'approved' });
    clearPromptResolution('pl_1', 'sig-plan');

    expect(getPromptResolution('pl_1')).toBeUndefined();
    expect(getPromptResolution('toolu_x', 'sig-plan')).toBeUndefined();
  });

  it('round-trips a draft and drops it once the prompt is answered', () => {
    setPromptDraft('dg_1', { selections: { a: ['x'] }, currentIndex: 2 });
    expect(getPromptDraft('dg_1')).toEqual({ selections: { a: ['x'] }, currentIndex: 2 });

    markPromptResolved({ id: 'dg_1', resolution: 'done' });
    expect(getPromptDraft('dg_1')).toBeUndefined();
  });

  it('notifies subscribers so a mounted card re-renders', () => {
    let calls = 0;
    const unsubscribe = subscribePromptResolutions(() => { calls++; });

    markPromptResolved({ id: 'q1', resolution: 'a' });
    expect(calls).toBe(1);

    unsubscribe();
    markPromptResolved({ id: 'q2', resolution: 'b' });
    expect(calls).toBe(1);
  });

  it('evicts the oldest answers so a long session stays bounded', () => {
    for (let i = 0; i < 260; i++) markPromptResolved({ id: `q${i}`, resolution: i });

    expect(getPromptResolution('q0')).toBeUndefined();
    expect(getPromptResolution('q259')).toBe(259);
  });

  it('ignores an undefined resolution instead of marking the card answered', () => {
    markPromptResolved({ id: 'q1', resolution: undefined });

    expect(isPromptResolved('q1')).toBe(false);
  });
});
