import type * as MonacoNs from 'monaco-editor';
import type { ContribEditorAction } from '../../../state/contribution-registry.js';
import type { OpenFile } from '../../../state/workspace.js';
import { parseModelPath } from './editor-models-path.js';

export interface PluginEditorContext {
  path: string;
  languageId: string;
  lineNumber: number;
  column: number;
  lineText: string;
}

export interface PluginGutterMarker {
  action: ContribEditorAction;
  context: PluginEditorContext;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

function globRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        // A globstar followed by a slash represents zero or more complete
        // path segments. Keeping the slash inside the optional group makes
        // `**/Dockerfile` match both the project-root file and nested files.
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`, 'i');
}

export function matchesEditorDocument(
  action: ContribEditorAction,
  path: string,
  languageId?: string,
): boolean {
  const selector = action.documentSelector;
  if (!selector) return true;

  const normalized = normalizePath(path);
  const basename = normalized.split('/').pop() ?? normalized;
  const fileMatches = !selector.filePatterns?.length || selector.filePatterns.some((pattern) => {
    const target = normalizePath(pattern).includes('/') ? normalized : basename;
    return globRegex(pattern).test(target);
  });
  const languageMatches = !selector.languageIds?.length
    || (languageId != null && selector.languageIds.some((id) => id.toLowerCase() === languageId.toLowerCase()));
  return fileMatches && languageMatches;
}

function lineMatchColumn(
  lineText: string,
  matcher: NonNullable<ContribEditorAction['gutter']>['line'],
): number | null {
  const trimmed = matcher.trim ? lineText.trim() : lineText;
  const leadingOffset = matcher.trim ? lineText.indexOf(trimmed) : 0;
  const candidate = matcher.caseSensitive === false ? trimmed.toLowerCase() : trimmed;
  const expected = matcher.caseSensitive === false ? matcher.text.toLowerCase() : matcher.text;

  if (matcher.match === 'equals') return candidate === expected ? leadingOffset + 1 : null;
  if (matcher.match === 'startsWith') return candidate.startsWith(expected) ? leadingOffset + 1 : null;
  if (matcher.match === 'contains') {
    const index = candidate.indexOf(expected);
    return index >= 0 ? leadingOffset + index + 1 : null;
  }
  const next = candidate.charAt(expected.length);
  return candidate.startsWith(expected) && (!next || /\s/.test(next)) ? leadingOffset + 1 : null;
}

export function collectPluginGutterMarkers(
  path: string,
  languageId: string,
  lines: readonly string[],
  actions: readonly ContribEditorAction[],
): Map<number, PluginGutterMarker[]> {
  const markers = new Map<number, PluginGutterMarker[]>();
  for (const action of actions) {
    if (!action.gutter || !action.runsTool || !matchesEditorDocument(action, path, languageId)) continue;
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index];
      const column = lineMatchColumn(lineText, action.gutter.line);
      if (column == null) continue;
      const lineNumber = index + 1;
      const existing = markers.get(lineNumber) ?? [];
      existing.push({
        action,
        context: { path, languageId, lineNumber, column, lineText },
      });
      markers.set(lineNumber, existing);
      if (action.gutter.occurrence === 'first') break;
    }
  }
  return markers;
}

function fallbackEditorContext(path?: string, languageId?: string): PluginEditorContext | undefined {
  if (!path) return undefined;
  return {
    path,
    languageId: languageId ?? 'plaintext',
    lineNumber: 1,
    column: 1,
    lineText: '',
  };
}

/**
 * Build command-palette context from the focused Monaco instance without ever
 * borrowing a model from another project or pane. If the live model is not
 * usable yet, retain the active document identity with a valid 1:1 position.
 */
export function pluginEditorContextFromEditor(
  editor: MonacoNs.editor.IStandaloneCodeEditor | null,
  projectId: number,
  fallbackPath?: string,
  fallbackLanguageId?: string,
): PluginEditorContext | undefined {
  const fallback = fallbackEditorContext(fallbackPath, fallbackLanguageId);
  const model = editor?.getModel();
  if (!editor || !model || model.isDisposed()) return fallback;

  const parsed = parseModelPath(model.uri.path);
  if (parsed.projectId != null && parsed.projectId !== projectId) return fallback;
  if (fallbackPath && normalizePath(parsed.relPath) !== normalizePath(fallbackPath)) return fallback;

  try {
    const rawPosition = editor.getPosition() ?? { lineNumber: 1, column: 1 };
    const lineNumber = Math.max(1, Math.min(rawPosition.lineNumber, model.getLineCount()));
    const column = Math.max(1, Math.min(rawPosition.column, model.getLineMaxColumn(lineNumber)));
    return {
      path: parsed.relPath,
      languageId: model.getLanguageId() || fallbackLanguageId || 'plaintext',
      lineNumber,
      column,
      lineText: model.getLineContent(lineNumber),
    };
  } catch {
    // The editor/model may be disposed between the guards and the reads.
    return fallback;
  }
}

function modelBelongsToFile(model: MonacoNs.editor.ITextModel, file: OpenFile): boolean {
  const parsed = parseModelPath(model.uri.path);
  return normalizePath(parsed.relPath) === normalizePath(file.path)
    && (parsed.projectId == null || parsed.projectId === file.projectId);
}

export function attachPluginEditorGutter(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: typeof MonacoNs,
  file: OpenFile,
  actions: readonly ContribEditorAction[],
  invoke: (markers: readonly PluginGutterMarker[]) => void,
): { dispose(): void } {
  const collection = editor.createDecorationsCollection([]);
  let lineMap = new Map<number, PluginGutterMarker[]>();
  let contentSubscription: MonacoNs.IDisposable | null = null;
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const rebuild = (): void => {
    const model = editor.getModel();
    if (!model || !modelBelongsToFile(model, file)) {
      lineMap = new Map();
      collection.clear();
      return;
    }
    const lines = Array.from({ length: model.getLineCount() }, (_, index) => model.getLineContent(index + 1));
    lineMap = collectPluginGutterMarkers(file.path, model.getLanguageId(), lines, actions);
    collection.set([...lineMap.entries()].map(([lineNumber, markers]) => {
      const primary = markers[0];
      const icon = primary.action.gutter?.icon ?? 'run';
      const tooltip = markers.length === 1
        ? (primary.action.gutter?.tooltip ?? primary.action.label)
        : markers.map((marker) => `- ${marker.action.gutter?.tooltip ?? marker.action.label}`).join('\n');
      return {
        range: new monaco.Range(lineNumber, 1, lineNumber, 1),
        options: {
          glyphMarginClassName: `mcp-plugin-gutter mcp-plugin-gutter-${icon}`,
          glyphMarginHoverMessage: { value: tooltip },
          glyphMargin: { position: monaco.editor.GlyphMarginLane.Left },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      };
    }));
  };

  const bindModel = (): void => {
    if (rebuildTimer) {
      clearTimeout(rebuildTimer);
      rebuildTimer = null;
    }
    contentSubscription?.dispose();
    contentSubscription = null;
    const model = editor.getModel();
    if (model && modelBelongsToFile(model, file)) {
      contentSubscription = model.onDidChangeContent(() => {
        if (rebuildTimer) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => {
          rebuildTimer = null;
          if (!disposed) rebuild();
        }, 300);
      });
    }
    rebuild();
  };

  const modelSubscription = editor.onDidChangeModel(bindModel);
  const mouseSubscription = editor.onMouseDown((event) => {
    if (!event.event.leftButton || event.target.type !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) return;
    const lane = event.target.detail.glyphMarginLane;
    if (lane != null && lane !== monaco.editor.GlyphMarginLane.Left) return;
    const lineNumber = event.target.position?.lineNumber;
    const markers = lineNumber == null ? undefined : lineMap.get(lineNumber);
    if (!markers?.length) return;
    event.event.preventDefault();
    event.event.stopPropagation();
    invoke(markers);
  });
  bindModel();

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      if (rebuildTimer) clearTimeout(rebuildTimer);
      contentSubscription?.dispose();
      modelSubscription.dispose();
      mouseSubscription.dispose();
      collection.clear();
      lineMap.clear();
    },
  };
}
