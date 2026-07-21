import { describe, it, expect } from 'vitest';
import { parseStylelintJson, parseEslintJson } from '../parsers.js';

describe('parseStylelintJson', () => {
  it('flattens warnings + parseErrors into SARIF results with severity levels', () => {
    const stdout = JSON.stringify([{
      source: '<input>', errored: true, parseErrors: [],
      warnings: [
        { line: 1, column: 10, endLine: 1, endColumn: 14, rule: 'color-no-invalid-hex', severity: 'error', text: 'bad hex' },
        { line: 2, column: 3, rule: 'block-no-empty', severity: 'warning', text: 'empty block' },
      ],
    }]);
    const run = parseStylelintJson(stdout);
    expect(run.tool).toBe('stylelint');
    expect(run.results).toHaveLength(2);
    expect(run.results[0]).toMatchObject({ ruleId: 'color-no-invalid-hex', level: 'error', message: { text: 'bad hex' } });
    expect(run.results[0]!.region).toEqual({ startLine: 1, startColumn: 10, endLine: 1, endColumn: 14 });
    expect(run.results[1]!.level).toBe('warning');
  });

  it('maps parseErrors to error-level results', () => {
    const stdout = JSON.stringify([{ warnings: [], parseErrors: [{ line: 4, column: 2, text: 'Unclosed block' }] }]);
    const run = parseStylelintJson(stdout);
    expect(run.results).toEqual([{ level: 'error', message: { text: 'Unclosed block' }, region: { startLine: 4, startColumn: 2 } }]);
  });

  it('yields an empty run for a clean file (no warnings)', () => {
    expect(parseStylelintJson(JSON.stringify([{ warnings: [] }])).results).toEqual([]);
  });
});

describe('parseEslintJson', () => {
  it('maps severity 2→error / 1→warning and preserves ranges + ruleId', () => {
    const stdout = JSON.stringify([{
      filePath: '/x/a.js',
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: "'x' unused", line: 1, column: 7, endLine: 1, endColumn: 8 },
        { ruleId: 'semi', severity: 1, message: 'Missing semicolon.', line: 1, column: 12, endLine: 2, endColumn: 1 },
      ],
    }]);
    const run = parseEslintJson(stdout);
    expect(run.tool).toBe('eslint');
    expect(run.results[0]).toMatchObject({ ruleId: 'no-unused-vars', level: 'error' });
    expect(run.results[1]).toMatchObject({ ruleId: 'semi', level: 'warning' });
    expect(run.results[1]!.region).toEqual({ startLine: 1, startColumn: 12, endLine: 2, endColumn: 1 });
  });

  it('tolerates a line-less whole-file error with null ruleId', () => {
    const stdout = JSON.stringify([{ filePath: '/x/a.js', messages: [{ ruleId: null, severity: 2, message: 'Parsing error' }] }]);
    const run = parseEslintJson(stdout);
    expect(run.results[0]).toMatchObject({ level: 'error', message: { text: 'Parsing error' } });
    expect(run.results[0]!.ruleId).toBeUndefined();
    expect(run.results[0]!.region.startLine).toBe(1);
  });
});
