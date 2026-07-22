import { describe, expect, it, vi } from 'vitest';
import { IGNORE_LANGUAGE, registerIgnoreHighlighting } from '../ignore-highlight.js';

describe('ignore highlighting', () => {
  it('registers Git and tool-specific ignore conventions', () => {
    const register = vi.fn();
    const setLanguageConfiguration = vi.fn();
    const setMonarchTokensProvider = vi.fn();
    const monaco = {
      languages: {
        getLanguages: () => [],
        register,
        setLanguageConfiguration,
        setMonarchTokensProvider,
      },
    };

    registerIgnoreHighlighting(monaco as never);

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      id: 'ignore',
      extensions: ['.ignore'],
      filenames: expect.arrayContaining(['.gitignore', '.dockerignore', '.mcpindexignore']),
    }));
    expect(setLanguageConfiguration).toHaveBeenCalledWith('ignore', expect.any(Object));
    expect(setMonarchTokensProvider).toHaveBeenCalledWith('ignore', IGNORE_LANGUAGE);
  });
});
