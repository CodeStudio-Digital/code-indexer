import { describe, expect, it, vi } from 'vitest';
import { formatJsonLinesText, registerJsonlSupport, validateJsonLinesText } from '../jsonl-support.js';

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

  it('publishes malformed-record diagnostics with Monaco line ranges', () => {
    const model = {
      isDisposed: () => false,
      getLanguageId: () => 'jsonl',
      getValue: () => '{"ok":true}\n{broken}',
      onDidChangeContent: vi.fn(),
      onWillDispose: vi.fn(),
    };
    const setModelMarkers = vi.fn();
    registerJsonlSupport({
      MarkerSeverity: { Error: 8 },
      languages: {
        setLanguageConfiguration: vi.fn(),
        registerDocumentFormattingEditProvider: vi.fn(),
      },
      editor: {
        getModels: () => [model],
        onDidCreateModel: vi.fn(),
        onDidChangeModelLanguage: vi.fn(),
        setModelMarkers,
      },
    } as never);
    expect(setModelMarkers).toHaveBeenCalledWith(model, 'jsonl', [expect.objectContaining({
      startLineNumber: 2, endLineNumber: 2, startColumn: expect.any(Number),
      endColumn: expect.any(Number), severity: 8, source: 'JSON Lines',
    })]);
  });

  it('formats one compact JSON value per line and preserves CRLF', () => {
    expect(formatJsonLinesText(' { "id": 1 } \r\n[ true, null ]\r\n'))
      .toBe('{"id":1}\r\n[true,null]\r\n');
  });

  it('refuses to rewrite a document containing an invalid record', () => {
    expect(formatJsonLinesText('{"ok":1}\n{broken}')).toBeNull();
  });
});
