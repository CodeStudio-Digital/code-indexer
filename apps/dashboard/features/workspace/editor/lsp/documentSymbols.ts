/**
 * Monaco DocumentSymbolProvider backed por lsp.documentSymbols — LIGA o
 * sticky scroll `outlineModel` (já configurado no MonacoMount), breadcrumbs
 * e melhora o Ctrl+F12. Fonte decidida no backend: TS navtree, server LSP
 * (textDocument/documentSymbol) ou índice estrutural.
 *
 * Cache leve por (uri, versionId): o outline model re-consulta em cada
 * mudança de view — sem cache seria um round-trip por scroll.
 */
import type * as MonacoNs from 'monaco-editor';
import type { DocumentSymbolDTO } from '@mcp/api-bus';
import { logLsp } from '../lsp-log.js';
import { modelBelongsToProject, relPath, type Monaco } from './dto.js';
import { documentSymbolsForModel } from './symbol-navigation-ui.js';

// Monaco SymbolKind por LITERAL numérico (const enum pode faltar no runtime).
const KIND: Record<string, number> = {
  file: 0, module: 1, namespace: 2, package: 3, class: 4, method: 5,
  property: 6, field: 7, constructor: 8, enum: 9, interface: 10,
  function: 11, variable: 12, constant: 13, string: 14, number: 15,
  boolean: 16, array: 17, object: 18, key: 19, null: 20, 'enum-member': 21,
  struct: 22, event: 23, operator: 24, 'type-parameter': 25,
  // TS navtree / index extra kinds:
  type: 10, alias: 12, const: 13, let: 12, var: 12, getter: 6, setter: 6,
  trait: 4, mixin: 4, 'local function': 11, script: 1,
};

function toMonacoSymbol(monaco: Monaco, dto: DocumentSymbolDTO): MonacoNs.languages.DocumentSymbol {
  const range = new monaco.Range(
    dto.range.start.line, dto.range.start.column, dto.range.end.line, dto.range.end.column);
  const sel = new monaco.Range(
    dto.selectionRange.start.line, dto.selectionRange.start.column,
    dto.selectionRange.end.line, dto.selectionRange.end.column);
  return {
    name: dto.name || '?',
    detail: dto.detail ?? '',
    kind: (KIND[dto.kind.toLowerCase()] ?? 12) as MonacoNs.languages.SymbolKind,
    tags: [],
    range,
    selectionRange: range.containsRange(sel) ? sel : range,
    children: dto.children?.map((c) => toMonacoSymbol(monaco, c)),
  };
}

export function registerDocumentSymbolProviders(
  monaco: Monaco,
  projectId: number,
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void> = async () => undefined,
): MonacoNs.IDisposable[] {
  const provider: MonacoNs.languages.DocumentSymbolProvider = {
    async provideDocumentSymbols(model) {
      if (!modelBelongsToProject(model, projectId)) return [];
      const versionId = model.getVersionId();
      const file = relPath(model);
      const lang = model.getLanguageId();
      const t0 = performance.now();
      try {
        await ensureSynced(model);
        const dtos = await documentSymbolsForModel(model, projectId);
        if (model.isDisposed() || model.getVersionId() !== versionId) return [];
        const result = (dtos ?? []).map((d) => toMonacoSymbol(monaco, d));
        logLsp({
          op: 'documentSymbols', file, lang,
          outcome: result.length > 0 ? 'ok' : 'empty', count: result.length, ms: performance.now() - t0,
        });
        return result;
      } catch (err) {
        logLsp({
          op: 'documentSymbols', file, lang, outcome: 'threw',
          ms: performance.now() - t0, err: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    },
  };
  return [monaco.languages.registerDocumentSymbolProvider('*', provider)];
}
