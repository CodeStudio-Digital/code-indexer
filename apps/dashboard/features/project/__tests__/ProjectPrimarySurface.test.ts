import { describe, expect, it } from 'vitest';
import { retainedPaneClassName } from '../ProjectPrimarySurface.js';

describe('retained primary surfaces', () => {
  it('hides an inactive editor through its composed parent layer', () => {
    const classes = retainedPaneClassName(false);
    expect(classes).toContain('opacity-0');
    expect(classes).toContain('pointer-events-none');
    expect(classes).not.toContain('invisible');
  });

  it('puts the active surface above retained panes', () => {
    expect(retainedPaneClassName(true)).toContain('z-10');
  });
});
