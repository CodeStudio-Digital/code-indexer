/**
 * Monaco RenameProvider (Shift+F6 no keymap IntelliJ) backed por lsp.rename.
 *
 * Fluxo: flushDoc (drena o didChange pendente — mesmo anti-race da completion)
 * → apiCall('lsp.rename') → separa os edits em:
 *   (a) arquivos COM model Monaco vivo → WorkspaceEdit nativo (undo integrado,
 *       versionId guarda contra buffer que mudou durante o round-trip);
 *   (b) arquivos SEM model → applyWorkspaceEditToClosedFiles (files.read/write).
 *
 * O backend devolve paths ABSOLUTOS canônicos (TS service / uriToPath) — o
 * mapeamento p/ relpath usa o root do projeto (mesmo idioma do editor-opener).
 * Rollback: localStorage['mcp-ide:rename-enabled'] = '0'.
 */
import type * as MonacoNs from 'monaco-editor';
import { apiCall } from '../../../../lib/api-client.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import { logLsp } from '../lsp-log.js';
import { modelFor } from '../editor-models.js';
import { modelBelongsToProject, relPath, toMonacoRange, type Monaco, type Position } from './dto.js';
import { applyWorkspaceEditToClosedFiles, type ContentEdit } from './apply-workspace-edit.js';

interface RenameEditDTO {
  file: string;
  range: { start: Position; end: Position };
  newText: string;
}

const GATE = 'mcp-ide:rename-enabled';

function renameEnabled(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem(GATE) !== '0';
  } catch {
    return true;
  }
}

/** abs canônico → relpath do projeto (case-insensitive — Windows). null = fora do root. */
function absToRel(root: string, absolute: string): string | null {
  const norm = (p: string): string =>
    p.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, (_m, d: string) => d.toLowerCase() + ':');
  const a = norm(absolute);
  const r = norm(root).replace(/\/$/, '');
  if (!a.toLowerCase().startsWith(r.toLowerCase() + '/')) return null;
  return a.slice(r.length + 1);
}

export function registerRenameProviders(
  monaco: Monaco,
  projectId: number,
  /** Drena o didChange pendente do arquivo antes do rename (anti-race). */
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void>,
): MonacoNs.IDisposable[] {
  let projectRoot: string | null = null;
  const ensureRoot = async (): Promise<string | null> => {
    if (projectRoot !== null) return projectRoot;
    try {
      const project = await apiCall<{ root_path?: string }>('projects.get', { id: projectId });
      if (project?.root_path) projectRoot = project.root_path;
    } catch { /* degrada para reject abaixo */ }
    return projectRoot;
  };

  const provider: MonacoNs.languages.RenameProvider = {
    async provideRenameEdits(model, position, newName) {
      const file = relPath(model);
      const lang = model.getLanguageId();
      const reject = (reason: string): MonacoNs.languages.WorkspaceEdit & MonacoNs.languages.Rejection =>
        ({ edits: [], rejectReason: reason });
      if (!modelBelongsToProject(model, projectId)) return reject('Model belongs to another project.');
      if (!renameEnabled()) return reject('Rename is disabled (mcp-ide:rename-enabled=0).');
      const t0 = performance.now();
      try {
        await ensureSynced(model);
        const [{ edits }, root] = await Promise.all([
          apiCall<{ edits: RenameEditDTO[] }>('lsp.rename', {
            projectId,
            file,
            position: { line: position.lineNumber, column: position.column },
            newName,
          }),
          ensureRoot(),
        ]);
        if (edits.length === 0) return reject('Nothing to rename at this position.');
        if (!root) return reject('Project root unavailable — cannot map rename targets.');

        const monacoEdits: MonacoNs.languages.IWorkspaceTextEdit[] = [];
        const openFiles = new Set<string>();
        const closed = new Map<string, ContentEdit[]>();
        let outside = 0;
        for (const e of edits) {
          const rel = absToRel(root, e.file);
          if (!rel) { outside++; continue; } // fora do projeto (ex.: d.ts de dependência)
          const target = modelFor(projectId, rel);
          if (target) {
            openFiles.add(rel);
            monacoEdits.push({
              resource: target.uri,
              versionId: target.getVersionId(),
              textEdit: { range: toMonacoRange(monaco, e.range), text: e.newText },
            });
          } else {
            const list = closed.get(rel) ?? [];
            list.push({ range: e.range, newText: e.newText });
            closed.set(rel, list);
          }
        }
        // Arquivos fechados são gravados AQUI (não entram no retorno — o Monaco
        // não conhece esses URIs); os abertos voltam como WorkspaceEdit nativo.
        const { written, skipped } = await applyWorkspaceEditToClosedFiles(projectId, closed);
        const total = openFiles.size + written.length;
        logLsp({ op: 'rename', file, lang, outcome: 'ok', count: edits.length, ms: performance.now() - t0 });
        if (total > 0) {
          const parts: string[] = [];
          if (skipped.length) parts.push(`${skipped.length} skipped (unsaved/unreadable)`);
          if (outside) parts.push(`${outside} outside the project`);
          toast.success(
            `Rename: ${total} file${total === 1 ? '' : 's'} updated`,
            parts.length ? { description: parts.join('; ') } : {},
          );
        }
        return { edits: monacoEdits };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logLsp({ op: 'rename', file, lang, outcome: 'threw', ms: performance.now() - t0, err: msg });
        return reject(msg);
      }
    },
  };

  return [monaco.languages.registerRenameProvider('*', provider)];
}
