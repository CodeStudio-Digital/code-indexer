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
 *   - onChange pushes content into the workspace store, flagging dirty
 *   - Tab switches re-create the model (Monaco keeps undo history per
 *     model — the editor instance is reused, the model swaps)
 *   (Save is dispatched via the keymap command registry — see 'file.save'.)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import { Loader2 } from 'lucide-react';
// Single source of truth shared with the backend's language router — the
// model's language id doubles as the LSP dispatch key (didOpen.languageId).
import { languageIdForPath as inferLanguage } from '@mcp/shared/utils/language-id.js';
import { useWorkspaceStore, type OpenFile } from '../../../state/workspace.js';
import { useUiDensity } from '../../../state/ui-density.js';
import { useEditorTheme, resolveThemeId } from '../../../state/editor-theme.js';
import { registerLspProviders, unregisterLspProviders } from './lspProvider.js';
import { reassertPhpHighlighting } from './php-highlight.js';
import {
  getActiveEditor,
  initEditorModels,
  restoreViewStateFor,
  saveViewStateFor,
  setActiveEditor,
  touchModel,
} from './editor-models.js';
import { modelPathFor } from './editor-models-path.js';
import { consumePendingReveal } from './pending-reveal.js';
import { attachNavTracking } from './nav-commands.js';
import { registerChatActions } from './chat-actions.js';
import { useEnsureFileContent } from './useEnsureFileContent.js';
import { useConflictMarkers } from './useConflictMarkers.js';
import { useChangeMarkers } from './useChangeMarkers.js';
import { useRunGutter } from './run/useRunGutter.js';
import { useSymbolNavigationGutter } from './useSymbolNavigationGutter.js';
import { registerRunActions } from './run/run-actions.js';
import { applyMonacoKeymap, watchKeymapPreset } from './monaco-keymap.js';
import { useEffectiveEditorSettings } from '../../../state/editor-settings.js';

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

export function MonacoMount({ file, onFocusPane, isActivePane = true }: MonacoMountProps) {
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  // Chave do modelo Monaco namespaced por projectId (W1b): keia o `path` da URI e as
  // chaves de view-state/LRU. O backend LSP continua recebendo o relpath limpo
  // (lspProvider/documentSync derivam via parseModelPath). `language` é inferido do
  // file.path REAL, não da chave prefixada.
  const modelKey = modelPathFor(file.projectId, file.path);
  const currentPathRef = useRef(modelKey);
  const setContent = useWorkspaceStore((s) => s.setContent);
  const editorFontPx = useUiDensity((s) => s.metrics.editorFontPx);
  const { settings: editorSettings } = useEffectiveEditorSettings(file.projectId, file.path);
  // Editor + monaco exposed as state (not just refs) so conflict UI can
  // attach reactively once the editor has actually mounted.
  const [editorInstance, setEditorInstance] = useState<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const [monacoInstance, setMonacoInstance] = useState<typeof MonacoNs | null>(null);

  // Lazy content: tabs open with null and fetch on activation; loaded tabs
  // revalidate by mtime (stat-only round trip when unchanged).
  useEnsureFileContent(file);
  // Inline conflict-marker decorations + Accept CodeLens, when this file is
  // a conflicted working-tree file (gated inside the hook).
  useConflictMarkers(file, editorInstance, monacoInstance);
  // IntelliJ-style git change markers: green/blue/triangle gutter bars vs the
  // file's HEAD baseline, live as you type (gated to git repos inside the hook).
  useChangeMarkers(file, editorInstance, monacoInstance);
  // IntelliJ-style ▶ run gutter for package.json/composer.json scripts and
  // Python __main__ (gated inside the hook to the relevant files).
  useRunGutter(file, editorInstance, monacoInstance);
  // Code Vision is provider-backed; these glyph-margin affordances make
  // usages/implementations visible even when CodeLens is outside the viewport.
  useSymbolNavigationGutter(file, editorInstance, monacoInstance);

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      setEditorInstance(editor);
      setMonacoInstance(monaco);
      initEditorModels(monaco);
      // Deterministically (re)assert our richer PHP tokenizer over Monaco's
      // async-loaded default for php files — see php-highlight.ts.
      if (editor.getModel()?.getLanguageId() === 'php') reassertPhpHighlighting(monaco);
      // Split-safe active-editor tracking: with two panes mounted, the global
      // active editor (commands: go-to-line, format, add-to-chat) must follow
      // FOCUS, not mount order. Set it on mount only for the active pane so a
      // restored split is deterministic; subsequent clicks update it via the
      // focus listener. Also notify the layout so the file tree / Quick Open
      // open into the focused pane.
      if (isActivePane) setActiveEditor(editor);
      editor.onDidFocusEditorText(() => {
        setActiveEditor(editor);
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
      // "Run File" (Shift+F10) — runs the active file with its runtime.
      registerRunActions(editor);
      // Histórico de navegação do cursor (Ctrl+Alt+Left/Right): empilha a
      // posição DEIXADA em saltos >10 linhas (debounce) e trocas de aba.
      // Vida útil atada ao editor (onDidDispose) — nada a limpar aqui.
      attachNavTracking(editor);
      // Cursor/scroll/selection across UNMOUNTS (diff/welcome detours) —
      // while mounted, the wrapper handles per-path swaps itself.
      restoreViewStateFor(modelKey, editor);
    },
    [modelKey, onFocusPane, isActivePane],
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
    registerLspProviders(monacoInstance, file.projectId);
    return () => unregisterLspProviders(file.projectId);
  }, [monacoInstance, file.projectId]);

  // Release the active-editor handle on unmount — but only if WE are the active
  // one. With a split, the other pane may currently hold focus; nulling it here
  // would break its commands.
  useEffect(() => () => {
    if (editorRef.current && getActiveEditor() === editorRef.current) setActiveEditor(null);
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

  const handleChange = useCallback(
    (value: string | undefined) => {
      // Monaco emits undefined when the model is being swapped out; ignore
      // those — only real edits should flag dirty. The MODEL is the source
      // of truth; the store mirror exists for dirty-tracking + persistence.
      if (value === undefined) return;
      setContent(file.projectId, file.path, value);
    },
    [file.projectId, file.path, setContent],
  );

  // Ctrl+S lives in the command registry now ('file.save', allowInInputs)
  // — dispatched by the global keymap dispatcher, preset-rebindable.

  const language = inferLanguage(file.path);
  const dark = useIsDark();
  // Resolve the editor color scheme from the global preference: per-language
  // override (e.g. PHP → IntelliJ Darcula) beats the dark/light default. The
  // theme prop drives `monaco.editor.setTheme`, which is GLOBAL — in a split
  // view both panes follow whichever one last (re)rendered; acceptable for v1.
  const themeDark = useEditorTheme((s) => s.darkTheme);
  const themeLight = useEditorTheme((s) => s.lightTheme);
  const perLanguage = useEditorTheme((s) => s.perLanguage);
  const themeId = resolveThemeId({
    appearance: dark ? 'dark' : 'light',
    languageId: language,
    state: { darkTheme: themeDark, lightTheme: themeLight, perLanguage },
  });

  // Stable options reference: @monaco-editor/react re-applies editor.updateOptions
  // whenever this object's identity changes, and MonacoMount re-renders on every
  // keystroke (setContent). Memoizing on the only dynamic value (font size) means
  // updateOptions fires on density change, not per keystroke — and with a split
  // that's two editors saved from the per-keystroke churn. (Theme is a separate prop.)
  const editorOptions = useMemo<MonacoNs.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      // ResizeObserver-driven relayout. Load-bearing for tab keep-alive
      // (MCP_TAB_KEEPALIVE): the editor stays mounted while hidden, so it
      // must re-measure itself on reveal / window-resize instead of relying
      // on a remount. Modern Monaco uses a ResizeObserver here (cheap).
      automaticLayout: true,
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
    [editorFontPx, editorSettings],
  );

  if (file.content === null) {
    return (
      <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }

  return (
    <Editor
      height="100%"
      width="100%"
      // Multi-model mode: `path` keys the model; keepCurrentModel keeps it
      // (and its undo stack) alive across tab switches and detours through
      // diff/welcome surfaces. UNCONTROLLED on purpose — a controlled
      // `value` makes the wrapper issue spurious full-range edits.
      // `modelKey` namespaces the URI by projectId (W1b) so two projects sharing
      // a relative path don't collide on one model.
      path={modelKey}
      defaultValue={file.content}
      keepCurrentModel
      defaultLanguage={language}
      language={language}
      theme={themeId}
      onMount={handleMount}
      onChange={handleChange}
      options={editorOptions}
    />
  );
}
