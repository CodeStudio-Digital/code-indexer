import { describe, it, expect } from 'vitest';
import { sarifToDiagnostics, sarifFixesToEdits, regionToRange, type SarifRun, type SarifResult } from '../sarif.js';

describe('sarifToDiagnostics', () => {
  it('maps level→severity, region→1-based range, ruleId→code, tool→source', () => {
    const run: SarifRun = {
      tool: 'stylelint',
      results: [
        { ruleId: 'color-no-invalid-hex', level: 'error', message: { text: 'bad hex' },
          region: { startLine: 3, startColumn: 10, endLine: 3, endColumn: 14 } },
        { ruleId: 'block-no-empty', level: 'warning', message: { text: 'empty' },
          region: { startLine: 5, startColumn: 1 } },
      ],
    };
    const diags = sarifToDiagnostics(run, 'src/a.css');
    expect(diags[0]).toEqual({
      file: 'src/a.css',
      range: { start: { line: 3, column: 10 }, end: { line: 3, column: 14 } },
      severity: 'error', message: 'bad hex', source: 'stylelint', code: 'color-no-invalid-hex',
    });
    // line/column-only fills end from start (Monaco widens a zero-width marker).
    expect(diags[1]!.range).toEqual({ start: { line: 5, column: 1 }, end: { line: 5, column: 1 } });
  });

  it('maps note→info, none→hint, missing level→warning; omits code when ruleId absent', () => {
    const run: SarifRun = {
      tool: 't', results: [
        { level: 'note', message: { text: 'n' }, region: { startLine: 1 } },
        { level: 'none', message: { text: 'h' }, region: { startLine: 1 } },
        { message: { text: 'w' }, region: { startLine: 1 } },
      ],
    };
    const d = sarifToDiagnostics(run, 'a.css');
    expect(d.map((x) => x.severity)).toEqual(['info', 'hint', 'warning']);
    expect('code' in d[2]!).toBe(false);
  });

  it('clamps degenerate regions to 1-based and keeps end ≥ start', () => {
    expect(regionToRange({ startLine: 0, startColumn: 0, endLine: 0 }))
      .toEqual({ start: { line: 1, column: 1 }, end: { line: 1, column: 1 } });
  });
});

describe('sarifFixesToEdits', () => {
  it('converts SARIF replacements to a 1-based workspace edit keyed by abs path', () => {
    const result: SarifResult = {
      ruleId: 'semi', level: 'warning', message: { text: 'missing ;' },
      region: { startLine: 1, startColumn: 5 },
      fixes: [{ deletedRegion: { startLine: 1, startColumn: 5, endLine: 1, endColumn: 5 }, insertedContent: { text: ';' } }],
    };
    const edit = sarifFixesToEdits(result, 'C:/p/a.js');
    expect(edit).toEqual({
      changes: { 'C:/p/a.js': [{ range: { start: { line: 1, column: 5 }, end: { line: 1, column: 5 } }, newText: ';' }] },
    });
  });

  it('returns null when the result carries no fix', () => {
    expect(sarifFixesToEdits({ level: 'error', message: { text: 'x' }, region: { startLine: 1 } }, 'a.js')).toBeNull();
  });
});
