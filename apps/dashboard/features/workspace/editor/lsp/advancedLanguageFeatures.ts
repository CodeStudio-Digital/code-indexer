/**
 * Monaco bridges for the LSP 3.17 features used heavily by Angular templates:
 * type definitions, folding ranges, inlay hints, and linked editing ranges.
 *
 * Public API DTOs are already 1-based. The backend/handle owns the only
 * 0-based LSP conversion seam; this module only adapts DTO shapes to Monaco.
 */
import type * as MonacoNs from 'monaco-editor';
import type {
  FoldingRangeDTO,
  InlayHintDTO,
  InlayHintLabelPartDTO,
  LinkedEditingRangesDTO,
  LspLocation,
} from '@mcp/api-bus';
import { apiCall } from '../../../../lib/api-client.js';
import { withMonacoCancellation } from './cancellation.js';
import { modelBelongsToProject, relPath, toMonacoRange, type Monaco } from './dto.js';

type EnsureSynced = (model: MonacoNs.editor.ITextModel) => Promise<void>;

function isCurrent(
  model: MonacoNs.editor.ITextModel,
  versionId: number,
  token: MonacoNs.CancellationToken,
): boolean {
  return !token.isCancellationRequested && !model.isDisposed() && model.getVersionId() === versionId;
}

function locationsToMonaco(monaco: Monaco, locations: LspLocation[]): MonacoNs.languages.Location[] {
  return locations.map((location) => ({
    uri: monaco.Uri.file(location.file),
    range: toMonacoRange(monaco, location.range),
  }));
}

function labelPartToMonaco(
  monaco: Monaco,
  part: InlayHintLabelPartDTO,
): MonacoNs.languages.InlayHintLabelPart {
  return {
    label: part.label,
    tooltip: part.tooltip,
    command: part.command
      ? { id: part.command.command, title: part.command.title, arguments: part.command.arguments }
      : undefined,
    location: part.location
      ? {
          uri: monaco.Uri.file(part.location.file),
          range: toMonacoRange(monaco, part.location.range),
        }
      : undefined,
  };
}

function hintToMonaco(monaco: Monaco, hint: InlayHintDTO): MonacoNs.languages.InlayHint {
  return {
    position: { lineNumber: hint.position.line, column: hint.position.column },
    label: typeof hint.label === 'string'
      ? hint.label
      : hint.label.map((part) => labelPartToMonaco(monaco, part)),
    kind: hint.kind,
    tooltip: hint.tooltip,
    textEdits: hint.textEdits?.map((edit) => ({
      range: toMonacoRange(monaco, edit.range),
      text: edit.newText,
    })),
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight,
  };
}

function compileWordPattern(source?: string): RegExp | undefined {
  if (!source) return undefined;
  try {
    return new RegExp(source);
  } catch {
    // A server regex can use syntax unsupported by the renderer's JS engine.
    // Linked ranges remain useful; Monaco falls back to the language word rule.
    return undefined;
  }
}

export function registerAdvancedLanguageFeatureProviders(
  monaco: Monaco,
  projectId: number,
  ensureSynced: EnsureSynced = async () => undefined,
): MonacoNs.IDisposable[] {
  const disposers: MonacoNs.IDisposable[] = [];

  disposers.push(monaco.languages.registerTypeDefinitionProvider('*', {
    async provideTypeDefinition(model, position, token) {
      if (!modelBelongsToProject(model, projectId)) return [];
      const versionId = model.getVersionId();
      try {
        await ensureSynced(model);
        const locations = await withMonacoCancellation(token, (signal) =>
          apiCall<LspLocation[]>('lsp.typeDefinition', {
            projectId,
            file: relPath(model),
            position: { line: position.lineNumber, column: position.column },
          }, { signal }));
        return isCurrent(model, versionId, token) ? locationsToMonaco(monaco, locations) : [];
      } catch {
        return [];
      }
    },
  }));

  disposers.push(monaco.languages.registerFoldingRangeProvider('*', {
    async provideFoldingRanges(model, _context, token) {
      if (!modelBelongsToProject(model, projectId)) return [];
      const versionId = model.getVersionId();
      try {
        await ensureSynced(model);
        const ranges = await withMonacoCancellation(token, (signal) =>
          apiCall<FoldingRangeDTO[]>('lsp.foldingRanges', {
            projectId,
            file: relPath(model),
          }, { signal }));
        if (!isCurrent(model, versionId, token)) return [];
        return ranges.map((range) => ({
          start: range.startLine,
          end: range.endLine,
          kind: range.kind ? monaco.languages.FoldingRangeKind.fromValue(range.kind) : undefined,
        }));
      } catch {
        return [];
      }
    },
  }));

  disposers.push(monaco.languages.registerInlayHintsProvider('*', {
    displayName: 'Language Server',
    async provideInlayHints(model, range, token) {
      const empty = (): MonacoNs.languages.InlayHintList => ({ hints: [], dispose() {} });
      if (!modelBelongsToProject(model, projectId)) return empty();
      const versionId = model.getVersionId();
      try {
        await ensureSynced(model);
        const dto = await withMonacoCancellation(token, (signal) =>
          apiCall<InlayHintDTO[]>('lsp.inlayHints', {
            projectId,
            file: relPath(model),
            range: {
              start: { line: range.startLineNumber, column: range.startColumn },
              end: { line: range.endLineNumber, column: range.endColumn },
            },
          }, { signal }));
        if (!isCurrent(model, versionId, token)) return empty();
        const hints = dto.map((hint) => hintToMonaco(monaco, hint));
        return {
          hints,
          // Monaco calls this when replacing a visible-range result. Release
          // references eagerly even though the backend keeps no result handle.
          dispose() { hints.length = 0; },
        };
      } catch {
        return empty();
      }
    },
  }));

  disposers.push(monaco.languages.registerLinkedEditingRangeProvider('*', {
    async provideLinkedEditingRanges(model, position, token) {
      if (!modelBelongsToProject(model, projectId)) return null;
      const versionId = model.getVersionId();
      try {
        await ensureSynced(model);
        const dto = await withMonacoCancellation(token, (signal) =>
          apiCall<LinkedEditingRangesDTO | null>('lsp.linkedEditingRanges', {
            projectId,
            file: relPath(model),
            position: { line: position.lineNumber, column: position.column },
          }, { signal }));
        if (!dto || !isCurrent(model, versionId, token)) return null;
        return {
          ranges: dto.ranges.map((range) => toMonacoRange(monaco, range)),
          wordPattern: compileWordPattern(dto.wordPattern),
        };
      } catch {
        return null;
      }
    },
  }));

  return disposers;
}
