import { describe, expect, it, vi } from 'vitest';
import { containPortalledScroll } from '../ui/combobox.js';

describe('containPortalledScroll', () => {
  it('keeps wheel and touch scrolling from reaching a modal scroll lock', () => {
    const stopPropagation = vi.fn();

    containPortalledScroll({ stopPropagation });

    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
