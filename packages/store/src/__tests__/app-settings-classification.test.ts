import { describe, expect, it } from 'vitest';
import { APP_SETTINGS, SETTING_CATEGORIES } from '../app-settings-catalog.js';

describe('app-settings classification', () => {
  it('keeps web search under indexing and removes the global Z.AI output cap', () => {
    expect(APP_SETTINGS.find((item) => item.key === 'BRAVE_API_KEY')?.category).toBe('indexing');
    expect(APP_SETTINGS.some((item) => item.key === 'ZAI_MAX_TOKENS')).toBe(false);
  });

  it('describes the remaining llm settings as model overrides', () => {
    expect(SETTING_CATEGORIES.find((category) => category.id === 'llm')?.label)
      .toBe('Model overrides');
  });
});
