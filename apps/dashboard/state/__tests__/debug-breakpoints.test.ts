import { beforeEach, describe, expect, it } from 'vitest';
import {
  debugBreakpointsForProject,
  isJavaScriptDebugPath,
  replaceDebugBreakpoints,
  toggleDebugBreakpoint,
  useDebugBreakpoints,
} from '../debug-breakpoints.js';

beforeEach(() => useDebugBreakpoints.setState({ byProject: {} }));

describe('debug breakpoints state', () => {
  it('toggles, sorts and removes project-relative breakpoints', () => {
    toggleDebugBreakpoint(7, 'src\\index.ts', 20);
    toggleDebugBreakpoint(7, 'src/index.ts', 4);
    expect(debugBreakpointsForProject(7)).toEqual([{
      path: 'src/index.ts',
      breakpoints: [{ line: 4 }, { line: 20 }],
    }]);

    toggleDebugBreakpoint(7, 'src/index.ts', 4);
    expect(debugBreakpointsForProject(7)[0]?.breakpoints).toEqual([{ line: 20 }]);
    toggleDebugBreakpoint(7, 'src/index.ts', 20);
    expect(debugBreakpointsForProject(7)).toEqual([]);
  });

  it('preserves advanced breakpoint fields when lines move', () => {
    replaceDebugBreakpoints(2, 'worker.ts', [
      { line: 9, condition: 'ready' },
      { line: 3, logMessage: 'value={value}' },
    ]);
    expect(debugBreakpointsForProject(2)[0]?.breakpoints).toEqual([
      { line: 3, logMessage: 'value={value}' },
      { line: 9, condition: 'ready' },
    ]);
  });

  it('restricts the first plugin to JavaScript and TypeScript sources', () => {
    expect(isJavaScriptDebugPath('src/index.ts')).toBe(true);
    expect(isJavaScriptDebugPath('src/component.tsx')).toBe(true);
    expect(isJavaScriptDebugPath('scripts/start.mjs')).toBe(true);
    expect(isJavaScriptDebugPath('src/main.py')).toBe(false);
  });
});
