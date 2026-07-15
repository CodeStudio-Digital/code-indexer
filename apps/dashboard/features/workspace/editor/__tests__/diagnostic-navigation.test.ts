import { describe, expect, it } from 'vitest';
import type * as MonacoNs from 'monaco-editor';
import { COMMAND_CATALOG } from '../../../../keymap/commands.js';
import {
  diagnosticIndex,
  NEXT_DIAGNOSTIC_COMMAND,
  PREVIOUS_DIAGNOSTIC_COMMAND,
} from '../diagnostic-navigation.js';

function marker(startLineNumber: number, startColumn = 1, endColumn = startColumn + 2) {
  return {
    startLineNumber,
    startColumn,
    endLineNumber: startLineNumber,
    endColumn,
    severity: 8,
    message: `Problem on ${startLineNumber}`,
  } as MonacoNs.editor.IMarker;
}

describe('floating diagnostic navigation', () => {
  const markers = [marker(4), marker(9, 5, 12), marker(15)];

  it('opens the diagnostic under the cursor before advancing', () => {
    expect(diagnosticIndex(markers, { lineNumber: 9, column: 8 }, 'next')).toBe(1);
    expect(diagnosticIndex(markers, { lineNumber: 9, column: 8 }, 'previous')).toBe(1);
  });

  it('selects by direction and wraps repeated navigation', () => {
    expect(diagnosticIndex(markers, { lineNumber: 10, column: 1 }, 'next')).toBe(2);
    expect(diagnosticIndex(markers, { lineNumber: 10, column: 1 }, 'previous')).toBe(1);
    expect(diagnosticIndex(markers, { lineNumber: 15, column: 1 }, 'next', 2)).toBe(0);
    expect(diagnosticIndex(markers, { lineNumber: 4, column: 1 }, 'previous', 0)).toBe(2);
  });

  it('returns no selection when the model has no diagnostics', () => {
    expect(diagnosticIndex([], { lineNumber: 1, column: 1 }, 'next')).toBe(-1);
  });

  it('routes both managed problem commands through the floating navigator', () => {
    expect(COMMAND_CATALOG.find((command) => command.id === 'editor.nextProblem')?.monacoCommand)
      .toBe(NEXT_DIAGNOSTIC_COMMAND);
    expect(COMMAND_CATALOG.find((command) => command.id === 'editor.previousProblem')?.monacoCommand)
      .toBe(PREVIOUS_DIAGNOSTIC_COMMAND);
  });
});
