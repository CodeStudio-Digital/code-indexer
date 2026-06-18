/**
 * Monaco CodeActionProvider backed by lsp.codeActions.
 *
 * Completion auto-import remains on CompletionItem.additionalTextEdits, but
 * diagnostics-driven fixes (missing imports, organize/source actions from
 * external servers, etc.) surface through Monaco's native lightbulb path.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { logLsp } from '../lsp-log.js';
import {
  relPath,
  toWorkspaceEdit,
  type CodeActionDTO,
  type Monaco,
} from './dto.js';

export function registerCodeActionProvider(
  monaco: Monaco,
  projectId: number,
  flushDoc: (rel: string) => Promise<void>,
): MonacoNs.IDisposable {
  return monaco.languages.registerCodeActionProvider('*', {
    async provideCodeActions(model, range, _context, token) {
      const file = relPath(model);
      const lang = model.getLanguageId();
      const t0 = performance.now();
      try {
        await flushDoc(file);
        const actions = await apiCall<CodeActionDTO[]>('lsp.codeActions', {
          projectId,
          file,
          range: {
            start: { line: range.startLineNumber, column: range.startColumn },
            end: { line: range.endLineNumber, column: range.endColumn },
          },
        });
        if (token.isCancellationRequested) return { actions: [], dispose() {} };
        logLsp({
          op: 'codeActions',
          file,
          lang,
          outcome: actions.length ? 'ok' : 'empty',
          count: actions.length,
          ms: performance.now() - t0,
        });
        return {
          actions: actions.map((a) => ({
            title: a.title,
            kind: a.kind,
            isPreferred: a.isPreferred,
            edit: toWorkspaceEdit(monaco, a.edit),
          })),
          dispose() {},
        };
      } catch (err) {
        logLsp({
          op: 'codeActions',
          file,
          lang,
          outcome: 'threw',
          ms: performance.now() - t0,
          err: err instanceof Error ? err.message : String(err),
        });
        return { actions: [], dispose() {} };
      }
    },
  }, { providedCodeActionKinds: ['quickfix', 'source', 'source.organizeImports', 'source.fixAll'] });
}
