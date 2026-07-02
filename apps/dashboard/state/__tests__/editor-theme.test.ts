/**
 * Pure tests for the editor-theme resolver: per-language override precedence,
 * appearance fallback, and stale-id rejection. No zustand/localStorage needed —
 * resolveThemeId takes the state explicitly.
 */
import { describe, it, expect } from 'vitest';
import { resolveThemeId, type EditorThemeState } from '../editor-theme.js';

const base: EditorThemeState = {
  darkTheme: 'one-dark-pro',
  lightTheme: 'github-light',
  perLanguage: { php: 'intellij-darcula' },
};

describe('resolveThemeId', () => {
  it('uses the dark default when no override and appearance is dark', () => {
    expect(resolveThemeId({ appearance: 'dark', languageId: 'typescript', state: base }))
      .toBe('one-dark-pro');
  });

  it('uses the light default when appearance is light', () => {
    expect(resolveThemeId({ appearance: 'light', languageId: 'typescript', state: base }))
      .toBe('github-light');
  });

  it('applies a per-language override over the default (in dark mode)', () => {
    expect(resolveThemeId({ appearance: 'dark', languageId: 'php', state: base }))
      .toBe('intellij-darcula');
  });

  it('applies a per-language override even in light mode (explicit choice)', () => {
    expect(resolveThemeId({ appearance: 'light', languageId: 'php', state: base }))
      .toBe('intellij-darcula');
  });

  it('ignores an override for a different language', () => {
    expect(resolveThemeId({ appearance: 'dark', languageId: 'python', state: base }))
      .toBe('one-dark-pro');
  });

  it('falls back to the default when languageId is null', () => {
    expect(resolveThemeId({ appearance: 'dark', languageId: null, state: base }))
      .toBe('one-dark-pro');
  });

  it('rejects an unknown override id and uses the default', () => {
    const state: EditorThemeState = { ...base, perLanguage: { php: 'not-a-real-theme' } };
    expect(resolveThemeId({ appearance: 'dark', languageId: 'php', state }))
      .toBe('one-dark-pro');
  });

  it('rejects an unknown default id and falls back to the app default', () => {
    const state: EditorThemeState = { darkTheme: 'ghost', lightTheme: 'vs', perLanguage: {} };
    expect(resolveThemeId({ appearance: 'dark', languageId: 'typescript', state }))
      .toBe('codestudio-dark');
  });
});
