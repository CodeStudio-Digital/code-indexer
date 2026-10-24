import { modelBelongsToProject, relPath, type LspLocationDTO, type Monaco, type Position } from './dto.js';
import type { DocumentSymbolDTO } from '@mcp/api-bus';
/**
 * IntelliJ-style symbol navigation UI on top of the existing LSP providers:
 * Code Vision links above declarations plus a clickable glyph-margin marker.
 * The links/glyphs are cheap — references and implementations are requested
 * only after the user clicks and a standalone-safe peek popup owns the results.
 */
import type * as MonacoNs from 'monaco-editor';
import { ensureDocumentSynced } from '../documentSync.js';
import { apiCall } from '../../../../lib/api-client.js';
import { toast } from '../../../../components/ui/prompt-dialog.js';
import i18n from '../../../../i18n/index.js';
import { showSymbolNavigationPopup } from './symbol-navigation-popup.js';
import { getActiveEditor } from '../editor-models.js';
import { onLspServerReady } from './server-ready.js';
import { documentSymbolsForModel, invalidateProjectSymbolCache } from './symbol-navigation-cache.js';

type SymbolAction = 'usages' | 'implementations';

interface NavigationSymbol {
  name: string;
  kind: string;
  position: Position;
  selectionRange: { start: Position; end: Position };
}

interface NavigationPayload {
  projectId: number;
  uri: string;
  position: Position;
  action: SymbolAction;
  name?: string;
}

const SHOW_USAGES_COMMAND = 'mcp.symbolNavigation.showUsages';

const SHOW_IMPLEMENTATIONS_COMMAND = 'mcp.symbolNavigation.showImplementations';

const MAX_NAVIGATION_SYMBOLS = 160;

let commandsRegistered = false;

const USAGE_KINDS = new Set([
  'class', 'interface', 'trait', 'struct', 'type', 'function', 'method',
  'constructor', 'property', 'field', 'getter', 'setter', 'enum',
]);

const IMPLEMENTATION_KINDS = new Set(['class', 'interface', 'trait', 'struct', 'type']);

function flattenNavigationSymbols(
  nodes: DocumentSymbolDTO[],
  model: MonacoNs.editor.ITextModel,
  output: NavigationSymbol[] = [],
): NavigationSymbol[] {
  for (const node of nodes) {
    const kind = node.kind.toLowerCase();
    if (USAGE_KINDS.has(kind) && output.length < MAX_NAVIGATION_SYMBOLS) {
      const selectionRange = preciseSelectionRange(model, node);
      output.push({
        name: node.name || '?',
        kind,
        position: selectionRange.start,
        selectionRange,
      });
    }
    if (node.children?.length && output.length < MAX_NAVIGATION_SYMBOLS) {
      flattenNavigationSymbols(node.children, model, output);
    }
    if (output.length >= MAX_NAVIGATION_SYMBOLS) break;
  }
  return output;
}

/**
 * Some servers (notably PHP language servers) return a document-symbol
 * selectionRange for the whole declaration line. Position-based operations
 * such as references only resolve when the cursor is actually on the symbol.
 * Tighten that range from the live Monaco text before producing any action.
 */
function preciseSelectionRange(
  model: MonacoNs.editor.ITextModel,
  symbol: DocumentSymbolDTO,
): NavigationSymbol['selectionRange'] {
  const supplied = symbol.selectionRange;
  const lineNumber = supplied.start.line;
  if (lineNumber < 1 || lineNumber > model.getLineCount()) return supplied;
  const line = model.getLineContent(lineNumber);
  const preferredOffset = Math.max(0, supplied.start.column - 1);
  let offset = line.indexOf(symbol.name, preferredOffset);
  if (offset < 0) offset = line.indexOf(symbol.name);
  if (offset < 0) return supplied;
  return {
    start: { line: lineNumber, column: offset + 1 },
    end: { line: lineNumber, column: offset + symbol.name.length + 1 },
  };
}

function activateSymbolNavigation(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: Monaco,
  payload: NavigationPayload,
): void {
  const model = editor.getModel();
  if (!model || model.uri.toString() !== payload.uri) return;
  const position = { lineNumber: payload.position.line, column: payload.position.column };
  editor.setPosition(position);
  editor.revealPositionInCenterIfOutsideViewport(position);
  editor.focus();
  void showSymbolLocations(monaco, payload.projectId, editor, payload);
}

function sameDeclaration(location: LspLocationDTO, file: string, position: Position): boolean {
  const normalize = (value: string): string => value.replace(/\\/g, '/').toLowerCase();
  const locationFile = normalize(location.file);
  const relativeFile = normalize(file).replace(/^\/+/, '');
  const sameFile = locationFile === relativeFile || locationFile.endsWith(`/${relativeFile}`);
  return sameFile
    && location.range.start.line === position.line
    && location.range.start.column === position.column;
}

async function showSymbolLocations(
  monaco: Monaco,
  projectId: number,
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  payload: NavigationPayload,
): Promise<void> {
  const model = editor.getModel();
  if (!model || model.uri.toString() !== payload.uri) return;
  const file = relPath(model);
  const method = payload.action === 'implementations' ? 'lsp.implementation' : 'lsp.references';
  let locations: LspLocationDTO[];
  try {
    await ensureDocumentSynced(projectId, model);
    locations = await apiCall<LspLocationDTO[]>(method, {
      projectId,
      file,
      position: payload.position,
    });
  } catch {
    toast.error(String(i18n.t('workspace:symbolNavigation.lookupFailed')));
    return;
  }
  if (payload.action === 'usages') {
    locations = locations.filter((location) => !sameDeclaration(location, file, payload.position));
  }
  if (editor.getModel()?.uri.toString() !== payload.uri) return;
  if (locations.length === 0) {
    toast.info(String(i18n.t(payload.action === 'implementations'
      ? 'workspace:symbolNavigation.noImplementations'
      : 'workspace:symbolNavigation.noUsages')));
    return;
  }

  const title = String(i18n.t(payload.action === 'implementations'
    ? 'workspace:symbolNavigation.implementationsTitle'
    : 'workspace:symbolNavigation.usagesTitle', { name: payload.name ?? '' }));
  await showSymbolNavigationPopup(editor, monaco, projectId, payload.position, locations, title);
}

function lensTitle(action: SymbolAction): string {
  return String(i18n.t(action === 'implementations'
    ? 'workspace:symbolNavigation.showImplementations'
    : 'workspace:symbolNavigation.showUsages'));
}

function gutterTitle(symbol: NavigationSymbol, action: SymbolAction): string {
  return String(i18n.t(action === 'implementations'
    ? 'workspace:symbolNavigation.gutterImplementations'
    : 'workspace:symbolNavigation.gutterUsages', { name: symbol.name }));
}

function containsPosition(
  range: NavigationSymbol['selectionRange'],
  position: MonacoNs.IPosition,
): boolean {
  const afterStart = position.lineNumber > range.start.line
    || (position.lineNumber === range.start.line && position.column >= range.start.column);
  const beforeEnd = position.lineNumber < range.end.line
    || (position.lineNumber === range.end.line && position.column <= range.end.column);
  return afterStart && beforeEnd;
}

function ensureNavigationCommands(monaco: Monaco): void {
  if (commandsRegistered) return;
  commandsRegistered = true;
  const run = (action: SymbolAction, payload?: NavigationPayload): Promise<void> | undefined => {
    const active = getActiveEditor();
    const editor = (active?.getModel()?.uri.toString() === payload?.uri
      ? active
      : monaco.editor.getEditors().find((candidate) =>
        candidate.getModel()?.uri.toString() === payload?.uri)) as
        MonacoNs.editor.IStandaloneCodeEditor | undefined;
    if (!editor || !payload) return;
    const next = { ...payload, action };
    const position = { lineNumber: next.position.line, column: next.position.column };
    editor.setPosition(position);
    editor.revealPositionInCenterIfOutsideViewport(position);
    editor.focus();
    return showSymbolLocations(monaco, payload.projectId, editor, next);
  };
  // CommandsRegistry is process-wide. Register once and route by URI/project;
  // disposing these with a project provider can orphan rendered CodeLens links.
  monaco.editor.registerCommand(
    SHOW_USAGES_COMMAND,
    (_accessor, payload: NavigationPayload) => run('usages', payload),
  );
  monaco.editor.registerCommand(
    SHOW_IMPLEMENTATIONS_COMMAND,
    (_accessor, payload: NavigationPayload) => run('implementations', payload),
  );
}

/** Project-scoped Code Vision provider backed by app-wide routed commands. */
export function registerSymbolNavigationCodeLensProvider(
  monaco: Monaco,
  projectId: number,
  ensureSynced: (model: MonacoNs.editor.ITextModel) => Promise<void> = async () => undefined,
): MonacoNs.IDisposable[] {
  ensureNavigationCommands(monaco);
  const changed = new monaco.Emitter<MonacoNs.languages.CodeLensProvider>();
  let codeLensProvider!: MonacoNs.languages.CodeLensProvider;
  codeLensProvider = {
    onDidChange: changed.event,
    async provideCodeLenses(model, token) {
      if (!modelBelongsToProject(model, projectId)) return { lenses: [], dispose() {} };
      const versionId = model.getVersionId();
      await ensureSynced(model);
      const symbols = flattenNavigationSymbols(await documentSymbolsForModel(model, projectId), model);
      if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== versionId) {
        return { lenses: [], dispose() {} };
      }

      const lenses: MonacoNs.languages.CodeLens[] = [];
      for (const symbol of symbols) {
        const range = new monaco.Range(
          symbol.position.line, symbol.position.column,
          symbol.position.line, symbol.position.column,
        );
        const basePayload: NavigationPayload = {
          projectId,
          uri: model.uri.toString(),
          position: symbol.position,
          action: 'usages',
          name: symbol.name,
        };
        lenses.push({
          range,
          command: {
            id: SHOW_USAGES_COMMAND,
            title: lensTitle('usages'),
            tooltip: gutterTitle(symbol, 'usages'),
            arguments: [basePayload],
          },
        });
        if (IMPLEMENTATION_KINDS.has(symbol.kind)) {
          lenses.push({
            range,
            command: {
              id: SHOW_IMPLEMENTATIONS_COMMAND,
              title: lensTitle('implementations'),
              tooltip: gutterTitle(symbol, 'implementations'),
              arguments: [{ ...basePayload, action: 'implementations' }],
            },
          });
        }
      }
      return { lenses, dispose() {} };
    },
  };
  const provider = monaco.languages.registerCodeLensProvider('*', codeLensProvider);
  const ready = onLspServerReady(projectId, () => {
    invalidateProjectSymbolCache(projectId);
    changed.fire(codeLensProvider);
  });
  return [provider, ready, changed];
}

/** Per-editor glyphs. Type declarations open implementations; members open usages. */
export function attachSymbolNavigationGutter(
  editor: MonacoNs.editor.IStandaloneCodeEditor,
  monaco: Monaco,
  projectId: number,
): MonacoNs.IDisposable {
  const model = editor.getModel();
  if (!model) return { dispose() {} };

  const collection = editor.createDecorationsCollection([]);
  let lineMap = new Map<number, { symbol: NavigationSymbol; action: SymbolAction }>();
  let navigationSymbols: NavigationSymbol[] = [];
  let codeLensTargets = new Map<string, Array<{ symbol: NavigationSymbol; action: SymbolAction }>>();
  let disposed = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const refresh = async (): Promise<void> => {
    const currentGeneration = ++generation;
    const versionId = model.getVersionId();
    const symbols = flattenNavigationSymbols(await documentSymbolsForModel(model, projectId), model);
    if (disposed || currentGeneration !== generation || model.isDisposed() || model.getVersionId() !== versionId) return;

    navigationSymbols = symbols;
    const nextLensTargets = new Map<string, Array<{ symbol: NavigationSymbol; action: SymbolAction }>>();
    const addLensTarget = (symbol: NavigationSymbol, action: SymbolAction): void => {
      const title = gutterTitle(symbol, action);
      const matches = nextLensTargets.get(title) ?? [];
      matches.push({ symbol, action });
      nextLensTargets.set(title, matches);
    };
    for (const symbol of symbols) {
      addLensTarget(symbol, 'usages');
      if (IMPLEMENTATION_KINDS.has(symbol.kind)) addLensTarget(symbol, 'implementations');
    }
    codeLensTargets = nextLensTargets;
    const next = new Map<number, { symbol: NavigationSymbol; action: SymbolAction }>();
    for (const symbol of symbols) {
      const action: SymbolAction = IMPLEMENTATION_KINDS.has(symbol.kind) ? 'implementations' : 'usages';
      const existing = next.get(symbol.position.line);
      if (!existing || (existing.action === 'usages' && action === 'implementations')) {
        next.set(symbol.position.line, { symbol, action });
      }
    }
    lineMap = next;
    collection.set([...next.entries()].map(([line, item]) => ({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: item.action === 'implementations'
          ? 'mcp-symbol-implementation-glyph'
          : 'mcp-symbol-usage-glyph',
        glyphMarginHoverMessage: { value: gutterTitle(item.symbol, item.action) },
        glyphMargin: { position: monaco.editor.GlyphMarginLane.Right },
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    })));
  };

  void refresh();
  const serverReady = onLspServerReady(projectId, () => {
    invalidateProjectSymbolCache(projectId);
    void refresh();
  });
  const content = model.onDidChangeContent(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void refresh(); }, 450);
  });
  // Native CodeLens renders anchors, but standalone Monaco can lose their
  // process-wide command during provider/project lifecycle churn. Capture the
  // anchors we own and route them directly to the same handler as gutter and
  // Ctrl+click; keyboard activation still produces this click event.
  const editorDom = editor.getDomNode();
  const codeLensClick = (event: MouseEvent): void => {
    const element = event.target instanceof Element ? event.target : null;
    if (!element || element.closest('.monaco-editor') !== editorDom) return;
    const glyph = element.closest<HTMLElement>(
      '.mcp-symbol-implementation-glyph, .mcp-symbol-usage-glyph',
    );
    if (glyph) {
      const y = glyph.getBoundingClientRect().top
        - (editorDom?.getBoundingClientRect().top ?? 0)
        + editor.getScrollTop();
      const item = [...lineMap.values()].reduce((best, candidate) => {
        if (!best) return candidate;
        const bestDistance = Math.abs(editor.getTopForLineNumber(best.symbol.position.line) - y);
        const candidateDistance = Math.abs(editor.getTopForLineNumber(candidate.symbol.position.line) - y);
        return candidateDistance < bestDistance ? candidate : best;
      }, undefined as { symbol: NavigationSymbol; action: SymbolAction } | undefined);
      if (!item) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      activateSymbolNavigation(editor, monaco, {
        projectId,
        uri: model.uri.toString(),
        position: item.symbol.position,
        action: item.action,
        name: item.symbol.name,
      });
      return;
    }
    const anchor = element?.closest<HTMLAnchorElement>('a[role="button"][title]');
    if (!anchor) return;
    const matches = codeLensTargets.get(anchor.title);
    if (!matches?.length) return;
    const anchorTop = anchor.getBoundingClientRect().top
      - (editorDom?.getBoundingClientRect().top ?? 0)
      + editor.getScrollTop();
    const match = matches.reduce((best, candidate) => {
      const bestDistance = Math.abs(editor.getTopForLineNumber(best.symbol.position.line) - anchorTop);
      const candidateDistance = Math.abs(editor.getTopForLineNumber(candidate.symbol.position.line) - anchorTop);
      return candidateDistance < bestDistance ? candidate : best;
    });
    event.preventDefault();
    event.stopImmediatePropagation();
    activateSymbolNavigation(editor, monaco, {
      projectId,
      uri: model.uri.toString(),
      position: match.symbol.position,
      action: match.action,
      name: match.symbol.name,
    });
  };
  if (typeof document !== 'undefined') document.addEventListener('click', codeLensClick, true);
  const mouse = editor.onMouseDown((event) => {
    if (!event.event.leftButton) return;
    if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN) {
      if (event.target.detail.glyphMarginLane !== monaco.editor.GlyphMarginLane.Right) return;
      const line = event.target.position?.lineNumber;
      if (!line) return;
      const item = lineMap.get(line);
      if (!item) return;
      event.event.preventDefault();
      event.event.stopPropagation();
      activateSymbolNavigation(editor, monaco, {
        projectId,
        uri: model.uri.toString(),
        position: item.symbol.position,
        action: item.action,
        name: item.symbol.name,
      });
      return;
    }

    // Keep Ctrl/Cmd+click on references as Go to Definition. Only declarations
    // are intercepted: navigating to themselves is not useful, so show usages
    // in the same usages popup instead.
    if (!event.event.ctrlKey && !event.event.metaKey) return;
    if (event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
    const clickedPosition = event.target.position;
    if (!clickedPosition) return;
    const declaration = navigationSymbols.find((symbol) => containsPosition(
      symbol.selectionRange,
      clickedPosition,
    ));
    if (!declaration) return;
    event.event.preventDefault();
    event.event.stopPropagation();
    activateSymbolNavigation(editor, monaco, {
      projectId,
      uri: model.uri.toString(),
      position: declaration.position,
      action: 'usages',
      name: declaration.name,
    });
  });

  return {
    dispose() {
      disposed = true;
      generation += 1;
      if (timer) clearTimeout(timer);
      content.dispose();
      serverReady.dispose();
      mouse.dispose();
      if (typeof document !== 'undefined') document.removeEventListener('click', codeLensClick, true);
      collection.clear();
    },
  };
}
