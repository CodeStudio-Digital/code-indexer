/**
 * Ação "Organize Imports" (Ctrl+Alt+O) — chama lsp.organizeImports para o
 * arquivo ativo e aplica os edits no model Monaco vivo via pushEditOperations
 * (undo integrado). Organize imports só toca o PRÓPRIO arquivo, então não há
 * ramo de "arquivos fechados" como no rename — os edits voltam todos para o
 * model ativo.
 *
 * `applied === false` = backend alcançável mas sem suporte (ex.: Intelephense
 * free) → toast informativo com o motivo, nunca um erro.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import { getActiveEditor } from '../editor-models.js';
import { logLsp } from '../lsp-log.js';
import type { Position } from './dto.js';

interface OrganizeImportsResult {
  edits: Array<{ file: string; range: { start: Position; end: Position }; newText: string }>;
  applied?: false;
  reason?: string;
}

/**
 * Aplica edits 1-based do api-bus ao model ativo. IRange é interface — objeto
 * plano serve (sem depender do namespace monaco; const enums ficam de fora).
 */
export function applyEditsToActiveModel(
  model: MonacoNs.editor.ITextModel,
  edits: OrganizeImportsResult['edits'],
): void {
  if (edits.length === 0) return;
  model.pushEditOperations(
    null,
    edits.map((e) => ({
      range: {
        startLineNumber: e.range.start.line,
        startColumn: e.range.start.column,
        endLineNumber: e.range.end.line,
        endColumn: e.range.end.column,
      },
      text: e.newText,
    })),
    () => null,
  );
}

/** Comando editor.organizeImports — arquivo/projeto ativos vêm do workspace store. */
export async function organizeImportsInActiveEditor(): Promise<void> {
  const s = useWorkspaceStore.getState();
  const projectId = s.activeProjectId;
  const file = s.activeFilePath;
  const model = getActiveEditor()?.getModel();
  if (!projectId || !file || !model) return;
  const t0 = performance.now();
  try {
    const res = await apiCall<OrganizeImportsResult>('lsp.organizeImports', { projectId, file });
    if (res.applied === false) {
      toast.info('Organize imports', { description: res.reason ?? 'Not supported for this file.' });
      logLsp({ op: 'organizeImports', file, lang: model.getLanguageId(), outcome: 'no-provider', ms: performance.now() - t0 });
      return;
    }
    applyEditsToActiveModel(model, res.edits);
    logLsp({
      op: 'organizeImports', file, lang: model.getLanguageId(),
      outcome: res.edits.length ? 'ok' : 'empty', count: res.edits.length, ms: performance.now() - t0,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    toast.error('Organize imports failed', { description: msg });
    logLsp({ op: 'organizeImports', file, lang: model.getLanguageId(), outcome: 'threw', ms: performance.now() - t0, err: msg });
  }
}
