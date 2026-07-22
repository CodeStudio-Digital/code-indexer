import { describe, expect, it } from 'vitest';
import {
  mapServerFoldingRanges,
  mapServerInlayHints,
  mapServerLinkedEditingRanges,
} from '../server-backend-ops.js';

describe('advanced LSP feature mappers', () => {
  it('converts folding ranges to 1-based lines and rejects malformed entries', () => {
    expect(mapServerFoldingRanges([
      { startLine: 0, endLine: 3, kind: 'region' },
      { startLine: 8, endLine: 4 },
    ])).toEqual([{ startLine: 1, endLine: 4, kind: 'region' }]);
  });

  it('preserves rich inlay labels while converting positions, locations and edits', () => {
    expect(mapServerInlayHints([{
      position: { line: 2, character: 4 },
      label: [{
        value: 'User',
        tooltip: { kind: 'markdown', value: 'Resolved user type' },
        location: {
          uri: 'file:///d:/proj/user.ts',
          range: { start: { line: 4, character: 1 }, end: { line: 4, character: 5 } },
        },
        command: { title: 'Open', command: 'editor.open', arguments: [1] },
      }],
      kind: 1,
      tooltip: 'Type hint',
      textEdits: [{
        range: { start: { line: 2, character: 4 }, end: { line: 2, character: 4 } },
        newText: ': User',
      }],
      paddingLeft: true,
    }])).toEqual([{
      position: { line: 3, column: 5 },
      label: [{
        label: 'User',
        tooltip: 'Resolved user type',
        location: {
          file: 'd:/proj/user.ts',
          range: { start: { line: 5, column: 2 }, end: { line: 5, column: 6 } },
        },
        command: { title: 'Open', command: 'editor.open', arguments: [1] },
      }],
      kind: 1,
      tooltip: 'Type hint',
      textEdits: [{
        range: { start: { line: 3, column: 5 }, end: { line: 3, column: 5 } },
        newText: ': User',
      }],
      paddingLeft: true,
      paddingRight: undefined,
    }]);
  });

  it('converts linked editing ranges and keeps the regex source', () => {
    expect(mapServerLinkedEditingRanges({
      ranges: [{
        start: { line: 0, character: 1 },
        end: { line: 0, character: 5 },
      }],
      wordPattern: '[A-Za-z]+',
    })).toEqual({
      ranges: [{
        start: { line: 1, column: 2 },
        end: { line: 1, column: 6 },
      }],
      wordPattern: '[A-Za-z]+',
    });
    expect(mapServerLinkedEditingRanges({ ranges: [] })).toBeNull();
  });
});
