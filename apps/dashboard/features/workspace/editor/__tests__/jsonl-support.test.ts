import { describe, expect, it } from 'vitest';
import { formatJsonLinesText, validateJsonLinesText } from '../jsonl-support.js';

describe('JSON Lines support', () => {
  it('validates each nonblank record independently', () => {
    expect(validateJsonLinesText('{"ok":true}\n\n[1,2]\nnull')).toEqual([]);
  });

  it('reports only the malformed record at its real line', () => {
    const problems = validateJsonLinesText('{"ok":true}\n  {broken}\n{"next":1}');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ lineNumber: 2 });
    expect(problems[0]!.startColumn).toBeGreaterThanOrEqual(3);
  });

  it('formats one compact JSON value per line and preserves CRLF', () => {
    expect(formatJsonLinesText(' { "id": 1 } \r\n[ true, null ]\r\n'))
      .toBe('{"id":1}\r\n[true,null]\r\n');
  });

  it('refuses to rewrite a document containing an invalid record', () => {
    expect(formatJsonLinesText('{"ok":1}\n{broken}')).toBeNull();
  });
});
