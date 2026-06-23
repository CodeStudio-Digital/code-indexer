import { describe, expect, it } from 'vitest';
import type { DiagnosticItem, DiagnosticsFrame } from '@mcp/api-bus';
import {
  applyFrame,
  emptyDiagnosticsState,
  flatten,
  type DiagnosticsState,
} from '../diagnostics-reducer.js';

function diag(over: Partial<DiagnosticItem> = {}): DiagnosticItem {
  return {
    file: 'src/a.ts',
    range: { start: { line: 1, column: 1 }, end: { line: 1, column: 2 } },
    severity: 'error',
    message: 'boom',
    source: 'ts',
    ...over,
  };
}

function frame(over: Partial<DiagnosticsFrame> = {}): DiagnosticsFrame {
  return { file: 'src/a.ts', source: 'ts', diagnostics: [diag()], ...over };
}

function reduce(...frames: DiagnosticsFrame[]): DiagnosticsState {
  return frames.reduce(applyFrame, emptyDiagnosticsState());
}

describe('diagnostics-reducer', () => {
  it('accumulates diagnostics across files and sources', () => {
    const state = reduce(
      frame({ file: 'src/a.ts', source: 'ts', diagnostics: [diag({ message: 'a-ts' })] }),
      frame({ file: 'src/b.ts', source: 'ts', diagnostics: [diag({ file: 'src/b.ts', message: 'b-ts' })] }),
      frame({ file: 'src/a.ts', source: 'index', diagnostics: [diag({ message: 'a-index', severity: 'warning' })] }),
    );
    const { items, errorCount, warningCount } = flatten(state);
    expect(items).toHaveLength(3);
    expect(errorCount).toBe(2);
    expect(warningCount).toBe(1);
  });

  it('replaces (does not append) the latest frame for a (file, source) pair', () => {
    const state = reduce(
      frame({ diagnostics: [diag({ message: 'old' }), diag({ message: 'old2' })] }),
      frame({ diagnostics: [diag({ message: 'new' })] }),
    );
    const { items } = flatten(state);
    expect(items.map((i) => i.message)).toEqual(['new']);
  });

  it('clears a source on an empty frame but keeps other sources for the file', () => {
    const state = reduce(
      frame({ source: 'ts', diagnostics: [diag({ message: 'ts-err' })] }),
      frame({ source: 'index', diagnostics: [diag({ message: 'idx-warn', severity: 'warning' })] }),
      frame({ source: 'ts', diagnostics: [] }), // backend says "ts is clean now"
    );
    const { items, errorCount } = flatten(state);
    expect(items.map((i) => i.message)).toEqual(['idx-warn']);
    expect(errorCount).toBe(0);
  });

  it('drops the file entirely once its last source clears', () => {
    const state = reduce(frame(), frame({ diagnostics: [] }));
    expect(flatten(state).items).toEqual([]);
    expect(state.size).toBe(0);
  });

  it('orders by severity, then file, then line, then column', () => {
    const state = reduce(
      frame({ file: 'src/z.ts', diagnostics: [diag({ file: 'src/z.ts', severity: 'warning', message: 'w' })] }),
      frame({
        file: 'src/a.ts',
        diagnostics: [
          diag({ file: 'src/a.ts', severity: 'error', message: 'e-l2', range: { start: { line: 2, column: 1 }, end: { line: 2, column: 1 } } }),
          diag({ file: 'src/a.ts', severity: 'error', message: 'e-l1', range: { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } } }),
        ],
      }),
    );
    expect(flatten(state).items.map((i) => i.message)).toEqual(['e-l1', 'e-l2', 'w']);
  });

  it('returns a new state reference per frame (React change detection)', () => {
    const empty = emptyDiagnosticsState();
    const next = applyFrame(empty, frame());
    expect(next).not.toBe(empty);
  });
});
