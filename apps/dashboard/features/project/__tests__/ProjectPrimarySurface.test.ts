import { describe, expect, it } from 'vitest';
import {
  PRIMARY_SURFACE_BUDGET,
  retainedPaneClassName,
  retainedPrimarySurfaces,
} from '../ProjectPrimarySurface.js';

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

  it('keeps only the active and immediately previous expensive surface', () => {
    let retained = retainedPrimarySurfaces([], 'editor');
    retained = retainedPrimarySurfaces(retained, 'sessions');
    expect(retained).toEqual(['sessions', 'editor']);

    retained = retainedPrimarySurfaces(retained, 'api');
    expect(retained).toEqual(['api', 'sessions']);
    expect(retained).toHaveLength(PRIMARY_SURFACE_BUDGET);
  });

  it('lets a transient active surface consume one renderer slot', () => {
    const retained = retainedPrimarySurfaces(['api', 'sessions'], 'preview');
    expect(retained).toEqual(['api']);
  });

  it('always retains an active stateful surface even with a zero budget', () => {
    expect(retainedPrimarySurfaces(['sessions'], 'editor', 0)).toEqual(['editor']);
    expect(retainedPrimarySurfaces(['sessions'], 'preview', 1)).toEqual([]);
  });
});
