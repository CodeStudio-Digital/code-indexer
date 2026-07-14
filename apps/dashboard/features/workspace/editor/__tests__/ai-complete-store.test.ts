import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerAiCompleteToggleEffect,
  useAiCompleteStore,
} from '../ai-complete-store.js';

describe('AI completion UI store', () => {
  afterEach(() => {
    useAiCompleteStore.setState({
      enabled: false,
      busy: false,
      issue: null,
      suggestionVisible: false,
      nudge: null,
    });
  });

  it('notifies the completion engine without importing it into settings UI', () => {
    const onToggle = vi.fn();
    const unregister = registerAiCompleteToggleEffect(onToggle);

    useAiCompleteStore.getState().setEnabled(true);
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(useAiCompleteStore.getState().enabled).toBe(true);

    unregister();
    useAiCompleteStore.getState().setEnabled(false);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
