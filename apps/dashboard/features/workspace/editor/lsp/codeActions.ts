/**
 * Monaco CodeActionProvider backed by lsp.codeActions.
 *
 * Completion auto-import remains on CompletionItem.additionalTextEdits, but
 * diagnostics-driven fixes (missing imports, organize/source actions from
 * external servers, etc.) surface through Monaco's native lightbulb path.
 */
import type * as MonacoNs from 'monaco-editor';
import i18n from '../../../../i18n/index.js';
import { apiCall } from '../../../../lib/api-client.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import { logLsp } from '../lsp-log.js';
import { cancelledWithin, withMonacoCancellation } from './cancellation.js';
import { applyWorkspaceEditToProject } from './apply-workspace-edit.js';
import {
  relPath,
  modelBelongsToProject,
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

export function registerCodeActionProvider(
  monaco: Monaco,
  projectId: number,
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void>,
): MonacoNs.IDisposable {
  if (!executeCommandRegistered) {
    executeCommandRegistered = true;
    monaco.editor.registerCommand(EXECUTE_COMMAND_ID, async (_accessor, payload: { projectId: number; action: CodeActionDTO }) => {
      if (!payload?.action) return;
      try {
        const apply = async (edit: NonNullable<CodeActionDTO['edit']>): Promise<void> => {
          const result = await applyWorkspaceEditToProject(monaco, payload.projectId, edit);
          if (result.skipped.length || result.outside.length) {
            toast.warning(i18n.t('lsp.codeActionPartial', { ns: 'workspace' }), {
              description: [
                result.skipped.length ? i18n.t('lsp.codeActionSkippedFiles', { ns: 'workspace', count: result.skipped.length }) : '',
                result.outside.length ? i18n.t('lsp.codeActionOutsideFiles', { ns: 'workspace', count: result.outside.length }) : '',
              ].filter(Boolean).join('; '),
            });
          }
        };

        // Monaco standalone cannot apply absolute LSP URIs to our
        // project-namespaced models, so all edits go through the workspace
        // applicator instead of CodeAction.edit / StandaloneBulkEditService.
        if (payload.action.edit) await apply(payload.action.edit);
        if (payload.action.command) {
          if (!payload.action.originServerId) throw new Error('Code action has no origin language server.');
          const executed = await apiCall<{ ok: true; edit?: NonNullable<CodeActionDTO['edit']> }>(
            'lsp.executeCodeAction',
            payload,
          );
          if (executed.edit) await apply(executed.edit);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[lsp] code action failed', error);
        toast.error(i18n.t('lsp.codeActionFailed', { ns: 'workspace' }), { description: message });
      }
    });
  }

  const mapAction = (action: CodeActionDTO, file: string): MonacoCodeAction => ({
    title: action.title,
    kind: action.kind,
    isPreferred: action.isPreferred,
    // Always execute through our command bridge. StandaloneBulkEditService
    // only looks up exact URIs and therefore cannot see namespaced models.
    edit: undefined,
    command: action.edit || action.command ? {
      id: EXECUTE_COMMAND_ID,
      title: action.title,
      arguments: [{ projectId, action }],
    } : undefined,
    _dto: action,
    _file: file,
  });

  return monaco.languages.registerCodeActionProvider('*', {
    async provideCodeActions(model, range, context, token) {
      if (!modelBelongsToProject(model, projectId)) return EMPTY;
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
        await ensureSynced(model);
        if (token.isCancellationRequested) return EMPTY;
        const actions = await withMonacoCancellation(token, (signal) =>
          apiCall<CodeActionDTO[]>('lsp.codeActions', {
            projectId,
            file,
            trigger: isAuto ? 'auto' : 'invoke',
            range: {
              start: { line: range.startLineNumber, column: range.startColumn },
              end: { line: range.endLineNumber, column: range.endColumn },
            },
          }, { signal }));
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
      const resolved = await withMonacoCancellation(token, (signal) =>
        apiCall<CodeActionDTO | null>('lsp.resolveCodeAction', {
          projectId, file: current._file, action: current._dto,
        }, { signal })).catch(() => null);
      if (!resolved || token.isCancellationRequested) return action;
      return mapAction(resolved, current._file);
    },
  }, { providedCodeActionKinds: ['quickfix', 'source', 'source.organizeImports', 'source.fixAll'] });
}
