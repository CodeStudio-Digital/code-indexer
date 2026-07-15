import { describe, expect, it } from 'vitest';
import { sessionSidebarClassName } from '../SessionSidebar.js';

describe('session sidebar layout', () => {
  it('keeps a workbench-docked sidebar visible below the lg breakpoint', () => {
    const classes = sessionSidebarClassName(true, false);

    expect(classes).toContain('h-full');
    expect(classes).toContain('w-full');
    expect(classes).toContain('translate-x-0');
    expect(classes).not.toContain('-translate-x-full');
    expect(classes).not.toContain('fixed');
  });

  it('retains the off-canvas behavior for the standalone mobile drawer', () => {
    expect(sessionSidebarClassName(false, false)).toContain('-translate-x-full');
    expect(sessionSidebarClassName(false, true)).toContain('translate-x-0');
  });
});
