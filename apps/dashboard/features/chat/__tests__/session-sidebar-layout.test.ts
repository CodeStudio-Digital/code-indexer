import { describe, expect, it } from 'vitest';
import { isExecutingSessionStatus, sessionSidebarClassName } from '../SessionSidebar.js';

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

  it('recognizes persisted live-run statuses without treating terminal sessions as active', () => {
    expect(isExecutingSessionStatus('running')).toBe(true);
    expect(isExecutingSessionStatus('in_progress')).toBe(true);
    expect(isExecutingSessionStatus('working')).toBe(true);
    expect(isExecutingSessionStatus('idle')).toBe(false);
    expect(isExecutingSessionStatus('error')).toBe(false);
  });
});
