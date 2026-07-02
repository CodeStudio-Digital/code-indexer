/**
 * Monaco formatting providers (Ctrl+Alt+L no keymap IntelliJ) backed por
 * lsp.formatting — SÓ para linguagens de server externo (php hoje). NÃO
 * registrar '*': isso ESCONDERIA os formatters built-in dos workers do
 * Monaco (TS/JS/JSON/CSS/HTML), que já cobrem essas linguagens localmente.
 *
 * flushDoc antes (mesmo anti-race da completion/rename); options vêm do
 * próprio model (tabSize/insertSpaces do arquivo aberto). DTO 1-based →
 * ISingleEditOperation-style TextEdit do Monaco.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import { relPath, toMonacoRange, type Monaco, type Position, type TextEditDTO } from './dto.js';

/** Server-backed languages only — keep Monaco's built-in formatters visible. */
const FORMAT_LANGS = ['php'] as const;

function modelOptions(model: MonacoNs.editor.ITextModel): { tabSize: number; insertSpaces: boolean } {
  const o = model.getOptions();
  return { tabSize: o.tabSize, insertSpaces: o.insertSpaces };
}

async function fetchEdits(
  monaco: Monaco,
  projectId: number,
  model: MonacoNs.editor.ITextModel,
  flushDoc: (rel: string) => Promise<void>,
  range?: { start: Position; end: Position },
): Promise<MonacoNs.languages.TextEdit[] | null> {
  const file = relPath(model);
  const lang = model.getLanguageId();
  const t0 = performance.now();
  try {
    await flushDoc(file);
    const edits = await apiCall<TextEditDTO[]>('lsp.formatting', {
      projectId,
      file,
      range,
      options: modelOptions(model),
    });
    logLsp({
      op: 'formatting', file, lang,
      outcome: edits.length ? 'ok' : 'empty', count: edits.length, ms: performance.now() - t0,
    });
    return edits.map((e) => ({ range: toMonacoRange(monaco, e.range), text: e.newText }));
  } catch (err) {
    logLsp({
      op: 'formatting', file, lang, outcome: 'threw',
      ms: performance.now() - t0, err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function registerFormattingProviders(
  monaco: Monaco,
  projectId: number,
  flushDoc: (rel: string) => Promise<void>,
): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];
  for (const lang of FORMAT_LANGS) {
    disposers.push(
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        async provideDocumentFormattingEdits(model) {
          return fetchEdits(monaco, projectId, model, flushDoc);
        },
      }),
      monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
        async provideDocumentRangeFormattingEdits(model, range) {
          return fetchEdits(monaco, projectId, model, flushDoc, {
            start: { line: range.startLineNumber, column: range.startColumn },
            end: { line: range.endLineNumber, column: range.endColumn },
          });
        },
      }),
    );
  }
  return disposers;
}
