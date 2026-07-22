import { beforeEach, describe, expect, it } from 'vitest';
import {
  debugBreakpointsForProject,
  isJavaScriptDebugPath,
  replaceDebugBreakpoints,
  selectDebugBreakpointRuntime,
  setDebugBreakpointRuntime,
  toggleDebugBreakpoint,
  useDebugBreakpoints,
} from '../debug-breakpoints.js';

beforeEach(() => useDebugBreakpoints.setState({ byProject: {}, runtimeByProject: {} }));

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

  it('keeps verified and relocated runtime presentation out of persisted breakpoints', () => {
    replaceDebugBreakpoints(2, 'worker.ts', [{ line: 9 }]);
    setDebugBreakpointRuntime(2, 'worker.ts', 'session-1', [{ line: 9 }], [{
      verified: false,
      line: 11,
      message: 'source map pending',
    }]);

    expect(selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', 'session-1')).toEqual([{
      sessionId: 'session-1',
      requestedLine: 9,
      line: 11,
      verified: false,
      message: 'source map pending',
    }]);
    expect(debugBreakpointsForProject(2)[0]?.breakpoints).toEqual([{ line: 9 }]);
  });

  it('returns referentially stable runtime snapshots for React store subscriptions', () => {
    const empty = selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', undefined);
    expect(selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', undefined)).toBe(empty);
    expect(selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', 'missing')).toBe(empty);

    setDebugBreakpointRuntime(2, 'worker.ts', 'session-1', [{ line: 9 }], [{
      verified: true,
      line: 9,
    }]);
    const runtime = selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', 'session-1');
    expect(selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', 'session-1')).toBe(runtime);
    expect(selectDebugBreakpointRuntime(useDebugBreakpoints.getState(), 2, 'worker.ts', 'session-2')).toBe(empty);
  });
});
