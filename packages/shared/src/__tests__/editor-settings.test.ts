import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITOR_SETTINGS, mergeEditorSettings } from '../editor-settings.js';

describe('editor settings merge', () => {
  it('applies default < global < project < editorconfig precedence', () => {
    const resolved = mergeEditorSettings(
      { tabSize: 3, wordWrap: 'on' },
      { tabSize: 4 },
      { tabSize: 8, insertSpaces: false },
    );
    expect(resolved.tabSize).toBe(8);
    expect(resolved.wordWrap).toBe('on');
    expect(resolved.insertSpaces).toBe(false);
    expect(resolved.formatOnSave).toBe(false);
    expect(DEFAULT_EDITOR_SETTINGS.formatOnType).toBe(false);
  });

  it('normalizes unsafe numeric/list values', () => {
    const resolved = mergeEditorSettings({ tabSize: 99, rulers: [-1, 80, 80, 900], fontSize: 99 });
    expect(resolved.tabSize).toBe(16);
    expect(resolved.rulers).toEqual([80]);
    expect(resolved.fontSize).toBe(40);
  });
});
