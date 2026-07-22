import type * as MonacoNs from 'monaco-editor';

type Monaco = typeof MonacoNs;

const MARKER_OWNER = 'jsonl';
const VALIDATION_DELAY_MS = 250;
const MAX_VALIDATION_CHARS = 5_000_000;
const MAX_VALIDATION_LINES = 50_000;

export interface JsonlProblem {
  lineNumber: number;
  startColumn: number;
  endColumn: number;
  message: string;
}

function errorPosition(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = /(?:at\s+)?position\s+(\d+)/i.exec(error.message);
  return match ? Number(match[1]) : null;
}

/** Validate each JSON Lines record independently; blank separator lines are allowed. */
export function validateJsonLinesText(text: string): JsonlProblem[] {
  if (text.length > MAX_VALIDATION_CHARS) return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > MAX_VALIDATION_LINES) return [];

  const problems: JsonlProblem[] = [];
  lines.forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    const leadingWhitespace = line.length - line.trimStart().length;
    try {
      JSON.parse(value);
    } catch (error) {
      const position = errorPosition(error) ?? 0;
      const startColumn = Math.min(
        Math.max(1, leadingWhitespace + position + 1),
        Math.max(1, line.length),
      );
      problems.push({
        lineNumber: index + 1,
        startColumn,
        endColumn: Math.min(line.length + 1, startColumn + 1),
        message: error instanceof Error ? `JSON inválido nesta linha: ${error.message}` : 'JSON inválido nesta linha',
      });
    }
  });
  return problems;
}

/** Compact records without ever joining them into one invalid JSON document. */
export function formatJsonLinesText(text: string): string | null {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const formatted: string[] = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value) {
      formatted.push('');
      continue;
    }
    try {
      formatted.push(JSON.stringify(JSON.parse(value)));
    } catch {
      return null;
    }
  }
  return formatted.join(eol);
}

/** Per-line diagnostics and a JSONL-safe Format Document implementation. */
export function registerJsonlSupport(monaco: Monaco): void {
  monaco.languages.setLanguageConfiguration('jsonl', {
    brackets: [['{', '}'], ['[', ']']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '"', close: '"' },
    ],
  });

  const attached = new WeakSet<MonacoNs.editor.ITextModel>();
  const timers = new WeakMap<MonacoNs.editor.ITextModel, ReturnType<typeof setTimeout>>();

  const validate = (model: MonacoNs.editor.ITextModel): void => {
    if (model.isDisposed()) return;
    const markers: MonacoNs.editor.IMarkerData[] = model.getLanguageId() === 'jsonl'
      ? validateJsonLinesText(model.getValue()).map((problem) => ({
        ...problem,
        severity: monaco.MarkerSeverity.Error,
        source: 'JSON Lines',
      }))
      : [];
    monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  };

  const schedule = (model: MonacoNs.editor.ITextModel, immediate = false): void => {
    const current = timers.get(model);
    if (current) clearTimeout(current);
    if (immediate) {
      timers.delete(model);
      validate(model);
      return;
    }
    timers.set(model, setTimeout(() => {
      timers.delete(model);
      validate(model);
    }, VALIDATION_DELAY_MS));
  };

  const attach = (model: MonacoNs.editor.ITextModel): void => {
    if (attached.has(model) || model.isDisposed()) return;
    attached.add(model);
    model.onDidChangeContent(() => schedule(model));
    model.onWillDispose(() => {
      const timer = timers.get(model);
      if (timer) clearTimeout(timer);
      timers.delete(model);
    });
    schedule(model, true);
  };

  monaco.editor.onDidCreateModel(attach);
  monaco.editor.onDidChangeModelLanguage(({ model }) => {
    attach(model);
    schedule(model, true);
  });
  monaco.editor.getModels().forEach(attach);

  monaco.languages.registerDocumentFormattingEditProvider('jsonl', {
    provideDocumentFormattingEdits(model) {
      const formatted = formatJsonLinesText(model.getValue());
      if (formatted == null || formatted === model.getValue()) return [];
      return [{ range: model.getFullModelRange(), text: formatted }];
    },
  });
}
