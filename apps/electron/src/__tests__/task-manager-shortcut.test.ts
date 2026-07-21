import { describe, expect, it } from 'vitest';
import { isTaskManagerShortcut } from '../task-manager-shortcut.js';

const baseInput = {
  type: 'keyDown' as const,
  key: 'Escape',
  code: 'Escape',
  shift: true,
  control: false,
  meta: false,
  alt: false,
};

describe('isTaskManagerShortcut', () => {
  it('accepts the Chrome-compatible Shift+Esc chord', () => {
    expect(isTaskManagerShortcut(baseInput)).toBe(true);
  });

  it('ignores key-up and chords with additional modifiers', () => {
    expect(isTaskManagerShortcut({ ...baseInput, type: 'keyUp' })).toBe(false);
    expect(isTaskManagerShortcut({ ...baseInput, control: true })).toBe(false);
    expect(isTaskManagerShortcut({ ...baseInput, meta: true })).toBe(false);
    expect(isTaskManagerShortcut({ ...baseInput, alt: true })).toBe(false);
  });

  it('ignores Shift combined with another key', () => {
    expect(isTaskManagerShortcut({ ...baseInput, key: 'E', code: 'KeyE' })).toBe(false);
  });
});
