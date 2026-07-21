/**
 * Monaco editor mount — the actual code editing surface.
 *
 * Wrapped in React.lazy + Suspense from EditorPane so the Monaco bundle
 * (~5 MB gzip) doesn't show up in the initial dashboard payload. Users
 * who never open the Workspace pay zero for the editor.
 *
 * Theme picks dark/light dynamically from the document's `.dark` class
 * (set by AppShell's theme toggle). Language inference is by extension —
 * Monaco's own registry handles 80+ languages out of the box.
 *
 * Editor wiring:
 *   - Monaco change events mark dirty immediately; a trailing debounce mirrors
 *     the full buffer into the workspace store for persistence fallbacks
 *   - Tab switches re-create the model (Monaco keeps undo history per
 *     model — the editor instance is reused, the model swaps)
 *   (Save is dispatched via the keymap command registry — see 'file.save'.)
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import { Loader2 } from 'lucide-react';
// Single source of truth shared with the backend's language router — the
// model's language id doubles as the LSP dispatch key (didOpen.languageId).
import {
  languageIdForDocument as inferLanguage,
  languageIdForPath,
} from '@mcp/shared/utils/language-id.js';
import type { OpenFile } from '../../../state/workspace.js';
import { useUiDensity } from '../../../state/ui-density.js';
import { useEditorTheme, resolveThemeId } from '../../../state/editor-theme.js';
import { registerLspProviders } from './lspProvider.js';
import {
  getActiveEditor,
  flushEditorContentMirror,
  initEditorModels,
  recordEditorContentChange,
  restoreViewStateFor,
  saveViewStateFor,
  setActiveEditor,
  touchModel,
} from './editor-models.js';
import { modelPathFor, parseModelPath } from './editor-models-path.js';
import { consumePendingReveal } from './pending-reveal.js';
import { attachNavTracking } from './nav-commands.js';
import { registerChatActions } from './chat-actions.js';
import { useEnsureFileContent } from './useEnsureFileContent.js';
import { useConflictMarkers } from './useConflictMarkers.js';
import { useChangeMarkers } from './useChangeMarkers.js';
import { useRunGutter } from './run/useRunGutter.js';
import { useDebugBreakpointGutter } from './debug/useDebugBreakpointGutter.js';
import { usePluginEditorGutter } from './usePluginEditorGutter.js';
import { useSymbolNavigationGutter } from './useSymbolNavigationGutter.js';
import { registerRunActions } from './run/run-actions.js';
import { applyMonacoKeymap, watchKeymapPreset } from './monaco-keymap.js';
import { useEffectiveEditorSettings } from '../../../state/editor-settings.js';
import { attachDiagnosticNavigation } from './diagnostic-navigation.js';
import { activateSharedMonacoTheme } from '../../../lib/monaco-theme.js';
import { registerSemanticSearchAction } from './semantic-search-action.js';
import { setupMonaco } from '../../../lib/monaco-setup.js';

setupMonaco();

function detectDarkMode(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('dark');
}

/**
 * Reactive `.dark` tracking. `detectDarkMode()` is a one-shot read; the editor
 * theme must also re-resolve when AppShell flips light/dark, so observe the
 * class on <html> and re-render on change (mirrors merge/MergeTabView).
 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(detectDarkMode);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const el = document.documentElement;
    const obs = new MutationObserver(() => setDark(el.classList.contains('dark')));
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    setDark(el.classList.contains('dark')); // sync any change since first render
    return () => obs.disconnect();
  }, []);
  return dark;
}

interface MonacoMountProps {
  file: OpenFile;
  /** Called when this editor gains focus — lets the split layout track the active pane. */
  onFocusPane?: () => void;
  /**
   * Whether this pane is the focused one. Gates the mount-time
   * `setActiveEditor` so a restored split doesn't let mount ORDER (rather than
   * focus) decide the global active editor. Defaults true (single-pane case).
   */
  isActivePane?: boolean;
}

/**
 * @monaco-editor/react only reconciles language when its `language` prop
 * changes. PHP → PHP swaps therefore leave restored models untouched. Own the
 * invariant here on every concrete model activation.
 */
export function reconcileModelLanguage(
  monaco: typeof MonacoNs,
  model: MonacoNs.editor.ITextModel,
): string {
  const parsed = parseModelPath(model.uri.path);
  const pathLanguage = languageIdForPath(parsed.relPath);
  // Extensions/conventional filenames cover nearly every model. Only inspect
  // the first line for truly extensionless files where a shebang can refine
  // plaintext; never materialize a multi-megabyte buffer just on focus.
  const expected = pathLanguage === 'plaintext'
    ? inferLanguage(parsed.relPath, model.getLineContent(1))
    : pathLanguage;
  if (model.getLanguageId() !== expected) monaco.editor.setModelLanguage(model, expected);
  return expected;
}

export function MonacoMount({ file, onFocusPane, isActivePane = true }: MonacoMountProps) {
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  // Chave do modelo Monaco namespaced por projectId (W1b): keia o `path` da URI e as
  // chaves de view-state/LRU. O backend LSP continua recebendo o relpath limpo
  // (lspProvider/documentSync derivam via parseModelPath). `language` é inferido do
  // file.path REAL, não da chave prefixada.
  const modelKey = modelPathFor(file.projectId, file.path);
  const currentPathRef = useRef(modelKey);
  const editorFontPx = useUiDensity((s) => s.metrics.editorFontPx);
  const { settings: editorSettings } = useEffectiveEditorSettings(file.projectId, file.path);
  // Editor + monaco exposed as state (not just refs) so conflict UI can
  // attach reactively once the editor has actually mounted.
  const [editorInstance, setEditorInstance] = useState<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const [monacoInstance, setMonacoInstance] = useState<typeof MonacoNs | null>(null);
  const activeThemeRef = useRef('codestudio-dark');
  const renderFrameRef = useRef<number | null>(null);
  const contentReady = file.content !== null;

  const scheduleEditorRefresh = useCallback((): void => {
    const editor = editorRef.current;
    if (!editor) return;
    const refresh = (): void => {
      renderFrameRef.current = null;
      if (!editor.getModel()) return;
      editor.layout();
      editor.render(true);
    };
    if (typeof requestAnimationFrame !== 'function') {
      refresh();
      return;
    }
    if (renderFrameRef.current !== null) cancelAnimationFrame(renderFrameRef.current);
    renderFrameRef.current = requestAnimationFrame(refresh);
  }, []);

  // Lazy content: tabs open with null and fetch on activation; loaded tabs
  // revalidate by mtime (stat-only round trip when unchanged).
  useEnsureFileContent(file);
  // Inline conflict-marker decorations + Accept CodeLens, when this file is
  // a conflicted working-tree file (gated inside the hook).
  useConflictMarkers(file, editorInstance, monacoInstance);
  // IntelliJ-style git change markers: green/blue/triangle gutter bars vs the
  // file's HEAD baseline, live as you type (gated to git repos inside the hook).
  useChangeMarkers(file, editorInstance, monacoInstance);
  // IntelliJ-style ▶ run gutter for scripts, project manifests, and source
  // entry points (gated inside the hook to the relevant files).
  useRunGutter(file, editorInstance, monacoInstance);
  // JavaScript/TypeScript breakpoint lane. Click the glyph margin or press
  // Ctrl+F8; persisted markers are passed to the next debug launch and kept
  // synchronized with an already-running DAP session.
  useDebugBreakpointGutter(file, editorInstance, monacoInstance);
  // Declarative, project-scoped gutters contributed by installed plugins.
  usePluginEditorGutter(file, editorInstance, monacoInstance);
  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      setEditorInstance(editor);
      setMonacoInstance(monaco);
      initEditorModels(monaco);
      const activateModel = (): void => {
        const model = editor.getModel();
        if (!model) return;
        const languageId = reconcileModelLanguage(monaco, model);
        // setTheme is process-global. Reassert the active workspace owner on
        // model activation so a retained auxiliary Monaco cannot leave it on
        // its own theme.
        if (isActivePane) {
          activateSharedMonacoTheme(languageId);
          monaco.editor.setTheme(activeThemeRef.current);
        }
        scheduleEditorRefresh();
      };
      activateModel();
      const modelActivation = editor.onDidChangeModel((event) => {
        // A fast tab switch must not strand the trailing fallback mirror for
        // the model that just became inactive.
        if (event.oldModelUrl) flushEditorContentMirror(monaco.editor.getModel(event.oldModelUrl));
        activateModel();
      });
      // Deliberately avoid @monaco-editor/react's `onChange`: it calls
      // model.getValue() for every edit, materializing the complete buffer on
      // the hot keystroke path. Monaco events carry deltas; dirty metadata is
      // immediate and editor-models performs one trailing full-value mirror.
      const modelContentChange = editor.onDidChangeModelContent(() => {
        const model = editor.getModel();
        if (model) recordEditorContentChange(model);
      });
      editor.onDidDispose(() => {
        flushEditorContentMirror(editor.getModel());
        modelActivation.dispose();
        modelContentChange.dispose();
        if (renderFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
          cancelAnimationFrame(renderFrameRef.current);
          renderFrameRef.current = null;
        }
      });
      // Split-safe active-editor tracking: with two panes mounted, the global
      // active editor (commands: go-to-line, format, add-to-chat) must follow
      // FOCUS, not mount order. Set it on mount only for the active pane so a
      // restored split is deterministic; subsequent clicks update it via the
      // focus listener. Also notify the layout so the file tree / Quick Open
      // open into the focused pane.
      if (isActivePane) setActiveEditor(editor);
      editor.onDidFocusEditorText(() => {
        setActiveEditor(editor);
        const model = editor.getModel();
        activateSharedMonacoTheme(model ? reconcileModelLanguage(monaco, model) : null);
        monaco.editor.setTheme(activeThemeRef.current);
        onFocusPane?.();
      });
      // Editor-level keymap (Ctrl+D duplicate, Ctrl+B declaration, …) per
      // the active preset — IntelliJ by default.
      applyMonacoKeymap(monaco);
      watchKeymapPreset(monaco); // live re-apply on every binding/preset change
      // NB: LSP providers are NOT wired here. Their lifetime is owned by the
      // project-scoped effect below (register on mount / projectId change,
      // unregister on cleanup) so switching or closing a project tears the
      // previous project's providers down instead of leaking them.
      // Copilot-rail actions: "Add Selection to Chat" (Ctrl/Cmd+I) and
      // "Add File to Chat" in the context menu. They read the active file
      // from the workspace store at run time, so registering once is safe.
      registerChatActions(editor);
      const semanticSearchAction = registerSemanticSearchAction(editor);
      // "Run File" (Shift+F10) — runs the active file with its runtime.
      registerRunActions(editor);
      // Histórico de navegação do cursor (Ctrl+Alt+Left/Right): empilha a
      // posição DEIXADA em saltos >10 linhas (debounce) e trocas de aba.
      // Vida útil atada ao editor (onDidDispose) — nada a limpar aqui.
      attachNavTracking(editor);
      // Replace Monaco's full-width marker zone with our compact floating
      // problem navigator while preserving the managed F2/F8 keymap actions.
      attachDiagnosticNavigation(editor, monaco);
      // Cursor/scroll/selection across UNMOUNTS (diff/welcome detours) —
      // while mounted, the wrapper handles per-path swaps itself.
      restoreViewStateFor(modelKey, editor);
      editor.onDidDispose(() => semanticSearchAction.dispose());
    },
    [modelKey, onFocusPane, isActivePane, scheduleEditorRefresh],
  );

  // LSP providers are project-scoped and live on the singleton Monaco namespace.
  // Tie their lifetime to this mount so switching/closing a project tears the
  // previous project's providers (documentSync listeners, diagnostics stream,
  // completion/nav providers) down — otherwise they accumulate on every switch.
  // Keyed on projectId (NOT path): within-project tab switches keep the same
  // registration; a project switch swaps it; unmount (Welcome/diff/markdown,
  // closing the last tab) tears it down. `monacoInstance` is the global Monaco
  // namespace (stable identity), so this re-runs only when monaco first loads
  // or the project changes — not on every keystroke or tab swap.
  useEffect(() => {
    if (!monacoInstance) return;
    const lease = registerLspProviders(monacoInstance, file.projectId);
    return () => lease.dispose();
  }, [monacoInstance, file.projectId]);

  // Code Vision is provider-backed. Declare this hook after the provider
  // lease so its first effect observes an already-created DocumentSync instead
  // of caching a pre-didOpen fallback result.
  useSymbolNavigationGutter(file, editorInstance, monacoInstance);

  // Release the active-editor handle on unmount — but only if WE are the active
  // one. With a split, the other pane may currently hold focus; nulling it here
  // would break its commands.
  useEffect(() => () => {
    if (editorRef.current && getActiveEditor() === editorRef.current) setActiveEditor(null);
    if (renderFrameRef.current !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
  }, []);

  // Track the active path: save view state when leaving a file (or
  // unmounting) and bump the model-LRU on every activation.
  useEffect(() => {
    currentPathRef.current = modelKey;
    touchModel(modelKey);
    return () => {
      const editor = editorRef.current;
      if (editor) saveViewStateFor(currentPathRef.current, editor);
    };
  }, [modelKey]);

  // One-shot reveal handoff (selection chip "open in editor", problems,
  // search). Waits for content — the wrapper swaps models a tick after the
  // path changes, hence the small delay (same trick as lspProvider's opener).
  useEffect(() => {
    if (file.content === null) return;
    const target = consumePendingReveal(file.path);
    if (!target) return;
    const t = setTimeout(() => {
      const editor = editorRef.current;
      if (!editor) return;
      editor.revealLineInCenter(target.line);
      editor.setPosition({ lineNumber: target.line, column: target.column });
      editor.focus();
    }, 60);
    return () => clearTimeout(t);
  }, [file.path, file.content]);

  // Ctrl+S lives in the command registry now ('file.save', allowInInputs)
  // — dispatched by the global keymap dispatcher, preset-rebindable.

  const language = inferLanguage(file.path, file.content);
  const dark = useIsDark();
  // Resolve the editor color scheme from the global preference. Monaco themes
  // are process-global, so the active pane becomes the owner and all retained
  // auxiliary editors consume the same shared theme snapshot.
  const themeDark = useEditorTheme((s) => s.darkTheme);
  const themeLight = useEditorTheme((s) => s.lightTheme);
  const perLanguage = useEditorTheme((s) => s.perLanguage);
  const themeId = resolveThemeId({
    appearance: dark ? 'dark' : 'light',
    languageId: language,
    state: { darkTheme: themeDark, lightTheme: themeLight, perLanguage },
  });
  activeThemeRef.current = themeId;
  const contentLoading = !contentReady;

  // Split focus, tab activation and return from a retained surface all need to
  // restore the global theme even when the theme prop itself stayed unchanged.
  useLayoutEffect(() => {
    if (!isActivePane) return;
    activateSharedMonacoTheme(language);
    if (monacoInstance) monacoInstance.editor.setTheme(themeId);
    scheduleEditorRefresh();
  }, [isActivePane, language, monacoInstance, modelKey, scheduleEditorRefresh, themeId]);

  // Stable options reference: @monaco-editor/react re-applies editor.updateOptions
  // whenever this object's identity changes. Memoizing on editor settings means
  // metadata/theme transitions do not re-apply the full option set. (Theme is a
  // separate prop.)
  const editorOptions = useMemo<MonacoNs.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      // ResizeObserver-driven relayout. Load-bearing for tab keep-alive
      // (MCP_TAB_KEEPALIVE): the editor stays mounted while hidden, so it
      // must re-measure itself on reveal / window-resize instead of relying
      // on a remount. Modern Monaco uses a ResizeObserver here (cheap).
      automaticLayout: true,
      // Keep one editor alive while a lazy file read is in flight, but block
      // edits against the temporary empty model under the loading overlay.
      readOnly: contentLoading,
      // Glyph margin hosts the run ▶ (and conflict/merge gutters). Explicit
      // so the run gutter always has a column to paint into.
      glyphMargin: true,
      fontSize: editorSettings.fontSize ?? editorFontPx,
      fontFamily: editorSettings.fontFamily,
      fontLigatures: editorSettings.fontLigatures,
      fontWeight: '400',
      lineHeight: 1.55,
      letterSpacing: 0,
      // Bracket pair colorization (Monaco ≥0.36) — JetBrains-style depth coloring.
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: true },
      guides: {
        bracketPairs: 'active',
        bracketPairsHorizontal: true,
        indentation: true,
      },
      // Minimap: subtle, small, no rendering of overview ruler so it
      // doesn't fight the gutter.
      minimap: {
        enabled: editorSettings.minimap,
        renderCharacters: false,
        maxColumn: 100,
        scale: 1,
        showSlider: 'mouseover',
      },
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      cursorBlinking: 'smooth',
      cursorSmoothCaretAnimation: 'on',
      wordWrap: editorSettings.wordWrap,
      wordWrapColumn: editorSettings.wordWrapColumn,
      detectIndentation: editorSettings.detectIndentation,
      tabSize: editorSettings.tabSize,
      insertSpaces: editorSettings.insertSpaces,
      renderLineHighlight: 'gutter',
      renderWhitespace: editorSettings.renderWhitespace,
      stickyScroll: { enabled: editorSettings.stickyScroll, defaultModel: 'outlineModel' },
      formatOnPaste: editorSettings.formatOnPaste,
      formatOnType: editorSettings.formatOnType,
      // Padding around the content area — keeps the first line off
      // the topbar shadow.
      padding: { top: 8, bottom: 8 },
      scrollbar: {
        verticalScrollbarSize: 10,
        horizontalScrollbarSize: 10,
        useShadows: false,
      },
      // The default scrollbars are okay; we hide the rulers since most
      // projects don't have a single shared line-length convention.
      rulers: editorSettings.rulers,
      // Acessory features that punch above their weight.
      folding: true,
      foldingHighlight: true,
      showFoldingControls: 'mouseover',
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      // IntelliJ-style completion widget: no generic word-soup (`abc`),
      // namespace/signature columns, locality bonus on top of our sortText.
      suggest: {
        showStatusBar: true,
        showWords: false, // kill `abc php`/`abc public` word completions
        showInlineDetails: true, // signature inline after the label
        localityBonus: true, // nearby symbols float up (additive to sortText)
        snippetsPreventQuickSuggestions: editorSettings.snippetSuggestions === 'none',
      },
      // Slightly denser popup rows (IntelliJ feel); paired with the rounded
      // chrome + colored symbol icons from the theme (see widget-colors.ts).
      suggestFontSize: Math.max(12, editorFontPx - 1),
      suggestLineHeight: Math.round(Math.max(12, editorFontPx - 1) * 1.6),
      quickSuggestions: editorSettings.quickSuggestions,
      suggestOnTriggerCharacters: editorSettings.suggestOnTriggerCharacters,
      acceptSuggestionOnEnter: editorSettings.acceptSuggestionOnEnter,
      tabCompletion: editorSettings.tabCompletion,
      snippetSuggestions: editorSettings.snippetSuggestions,
      wordBasedSuggestions: editorSettings.wordBasedSuggestions,
      inlayHints: { enabled: 'onUnlessPressed' },
      codeLens: true,
      // Force semantic highlighting ON (default is 'configuredByTheme', and the
      // standalone vs/vs-dark themes DON'T enable it — so LSP semantic tokens
      // for ts/js/php/python were never painted). This is what lets a theme
      // colour methods ≠ properties ≠ functions from the language server.
      'semanticHighlighting.enabled': true,
      // Navigation behaviour for Ctrl+Click on a symbol.
      //   - definitions/type definitions: `'goto'` jumps to the first result
      //     immediately; the default `'peek'` popup doesn't fire our editor
      //     opener consistently on double-click, so it reads as broken.
      //   - implementations: keep `'gotoAndPeek'` — usually 1, but the peek
      //     list is useful when N>1.
      //   - references: `'gotoAndPeek'` for the same reason.
      gotoLocation: {
        multipleDefinitions: 'goto',
        multipleTypeDefinitions: 'goto',
        multipleImplementations: 'gotoAndPeek',
        multipleReferences: 'gotoAndPeek',
        multipleDeclarations: 'goto',
      },
    }),
    [contentLoading, editorFontPx, editorSettings],
  );

  return (
    <div className="absolute inset-0">
      {/* Multi-model mode: `path` keys the model; keepCurrentModel keeps it
          (and its undo stack) alive across tab switches and detours through
          diff/welcome surfaces. UNCONTROLLED on purpose — a controlled
          `value` makes the wrapper issue spurious full-range edits.
          `modelKey` namespaces the URI by projectId so equal relative paths
          from different projects cannot collide on one model. */}
      <Editor
        height="100%"
        width="100%"
        path={modelKey}
        defaultValue={file.content ?? ''}
        keepCurrentModel
        defaultLanguage={language}
        language={language}
        theme={themeId}
        onMount={handleMount}
        options={editorOptions}
      />
      {contentLoading && (
        <div className="absolute inset-0 z-10 grid place-items-center bg-background/80 text-xs text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      )}
    </div>
  );
}
