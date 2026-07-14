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

const EMPTY = { actions: [], dispose() {} };
/** Coalesce cursor/selection churn: Monaco re-invokes the provider on every
 *  tick and cancels the prior token, so a short wait collapses the burst. */
const DEBOUNCE_MS = 150;
const EXECUTE_COMMAND_ID = 'mcp.lsp.executeCodeAction';
let executeCommandRegistered = false;
type MonacoCodeAction = MonacoNs.languages.CodeAction & { _dto: CodeActionDTO; _file: string };

/** Resolve true if `token` cancels within `ms` (or is already cancelled). */
function cancelledWithin(ms: number, token: MonacoNs.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) return resolve(true);
    const timer = setTimeout(() => { sub.dispose(); resolve(false); }, ms);
    const sub = token.onCancellationRequested(() => { clearTimeout(timer); resolve(true); });
  });
}

export function registerCodeActionProvider(
  monaco: Monaco,
  projectId: number,
  flushDoc: (rel: string) => Promise<void>,
): MonacoNs.IDisposable {
  if (!executeCommandRegistered) {
    executeCommandRegistered = true;
    monaco.editor.registerCommand(EXECUTE_COMMAND_ID, (_accessor, payload: { projectId: number; action: CodeActionDTO }) => {
      if (!payload?.action?.originServerId) return;
      void apiCall('lsp.executeCodeAction', payload).catch((error) => {
        console.error('[lsp] command-backed code action failed', error);
      });
    });
  }

  const mapAction = (action: CodeActionDTO, file: string): MonacoCodeAction => ({
    title: action.title,
    kind: action.kind,
    isPreferred: action.isPreferred,
    edit: toWorkspaceEdit(monaco, action.edit),
    command: action.command ? {
      id: EXECUTE_COMMAND_ID,
      title: action.title,
      arguments: [{ projectId, action }],
    } : undefined,
    _dto: action,
    _file: file,
  });

  return monaco.languages.registerCodeActionProvider('*', {
    async provideCodeActions(model, range, context, token) {
      const file = relPath(model);
      const lang = model.getLanguageId();
      // Debounce ONLY the auto-trigger (lightbulb on cursor/marker churn):
      // Monaco cancels the superseded token during the wait so the burst
      // coalesces. An explicit Quick-Fix (Ctrl+.) is `Invoke` — run it now,
      // no fixed latency. Cancel is still honored after flush + after the RPC.
      const isAuto = context.trigger === monaco.languages.CodeActionTriggerType.Auto;
      if (isAuto && (await cancelledWithin(DEBOUNCE_MS, token))) return EMPTY;
      const t0 = performance.now();
      try {
        await flushDoc(file);
        if (token.isCancellationRequested) return EMPTY;
        const actions = await apiCall<CodeActionDTO[]>('lsp.codeActions', {
          projectId,
          file,
          range: {
            start: { line: range.startLineNumber, column: range.startColumn },
            end: { line: range.endLineNumber, column: range.endColumn },
          },
        });
        if (token.isCancellationRequested) return EMPTY;
        logLsp({
          op: 'codeActions',
          file,
          lang,
          outcome: actions.length ? 'ok' : 'empty',
          count: actions.length,
          ms: performance.now() - t0,
        });
        return {
          actions: actions.map((action) => mapAction(action, file)),
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
        return EMPTY;
      }
    },
    async resolveCodeAction(action, token) {
      const current = action as MonacoCodeAction;
      if (!current._dto.needsResolve || token.isCancellationRequested) return action;
      const resolved = await apiCall<CodeActionDTO | null>('lsp.resolveCodeAction', {
        projectId, file: current._file, action: current._dto,
      }).catch(() => null);
      if (!resolved || token.isCancellationRequested) return action;
      return mapAction(resolved, current._file);
    },
  }, { providedCodeActionKinds: ['quickfix', 'source', 'source.organizeImports', 'source.fixAll'] });
}
