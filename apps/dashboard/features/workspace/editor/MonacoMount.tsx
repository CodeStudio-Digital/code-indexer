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
 * Day 7 wiring:
 *   - onChange pushes content into the workspace store, flagging dirty
 *   - Ctrl/Cmd+S calls files.write and clears the dirty flag
 *   - Tab switches re-create the model (Monaco keeps undo history per
 *     model — the editor instance is reused, the model swaps)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoNs from 'monaco-editor';
import { Loader2 } from 'lucide-react';
// Single source of truth shared with the backend's language router — the
// model's language id doubles as the LSP dispatch key (didOpen.languageId).
import { languageIdForPath as inferLanguage } from '@mcp/shared/utils/language-id.js';
import { useWorkspaceStore, type OpenFile } from '../../../state/workspace.js';
import { registerLspProviders } from './lspProvider.js';
import {
  initEditorModels,
  restoreViewStateFor,
  saveViewStateFor,
  setActiveEditor,
  touchModel,
} from './editor-models.js';
import { consumePendingReveal } from './pending-reveal.js';
import { registerChatActions } from './chat-actions.js';
import { useEnsureFileContent } from './useEnsureFileContent.js';
import { useConflictMarkers } from './useConflictMarkers.js';
import { applyMonacoKeymap } from './monaco-keymap.js';
import { useKeymapStore } from '../../../keymap/keymap-store.js';

function detectDarkMode(): boolean {
  if (typeof document === 'undefined') return true;
  return document.documentElement.classList.contains('dark');
}

interface MonacoMountProps {
  file: OpenFile;
}

export function MonacoMount({ file }: MonacoMountProps) {
  const editorRef = useRef<MonacoNs.editor.IStandaloneCodeEditor | null>(null);
  const currentPathRef = useRef(file.path);
  const setContent = useWorkspaceStore((s) => s.setContent);
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

  const handleMount = useCallback<OnMount>(
    (editor, monaco) => {
      editorRef.current = editor;
      setEditorInstance(editor);
      setMonacoInstance(monaco);
      initEditorModels(monaco);
      setActiveEditor(editor);
      // Editor-level keymap (Ctrl+D duplicate, Ctrl+B declaration, …) per
      // the active preset — IntelliJ by default.
      applyMonacoKeymap(monaco, useKeymapStore.getState().preset);
      // Wire LSP providers on first mount for this project. The registry
      // is idempotent per projectId, so re-mounts (tab switches) are
      // cheap. Switching project tears the previous set down.
      registerLspProviders(monaco, file.projectId);
      // Copilot-rail actions: "Add Selection to Chat" (Ctrl/Cmd+I) and
      // "Add File to Chat" in the context menu. They read the active file
      // from the workspace store at run time, so registering once is safe.
      registerChatActions(editor, monaco);
      // Cursor/scroll/selection across UNMOUNTS (diff/welcome detours) —
      // while mounted, the wrapper handles per-path swaps itself.
      restoreViewStateFor(file.path, editor);
    },
    [file.projectId, file.path],
  );

  // Release the active-editor handle on unmount (commands no-op cleanly).
  useEffect(() => () => {
    if (editorRef.current) setActiveEditor(null);
  }, []);

  // Track the active path: save view state when leaving a file (or
  // unmounting) and bump the model-LRU on every activation.
  useEffect(() => {
    currentPathRef.current = file.path;
    touchModel(file.path);
    return () => {
      const editor = editorRef.current;
      if (editor) saveViewStateFor(currentPathRef.current, editor);
    };
  }, [file.path]);

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
      setContent(file.path, value);
    },
    [file.path, setContent],
  );

  // Ctrl+S lives in the command registry now ('file.save', allowInInputs)
  // — dispatched by the global keymap dispatcher, preset-rebindable.

  const language = inferLanguage(file.path);
  const dark = detectDarkMode();

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
      path={file.path}
      defaultValue={file.content}
      keepCurrentModel
      defaultLanguage={language}
      language={language}
      theme={dark ? 'vs-dark' : 'vs'}
      onMount={handleMount}
      onChange={handleChange}
      options={{
        fontSize: 13,
        fontFamily: 'JetBrains Mono, Cascadia Code, Consolas, "Liberation Mono", Menlo, monospace',
        fontLigatures: true,
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
          enabled: true,
          renderCharacters: false,
          maxColumn: 100,
          scale: 1,
          showSlider: 'mouseover',
        },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        wordWrap: 'off',
        tabSize: 2,
        renderLineHighlight: 'gutter',
        renderWhitespace: 'selection',
        stickyScroll: { enabled: true, defaultModel: 'outlineModel' },
        formatOnPaste: true,
        formatOnType: false,
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
        rulers: [],
        // Acessory features that punch above their weight.
        folding: true,
        foldingHighlight: true,
        showFoldingControls: 'mouseover',
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
        // IntelliJ-style completion widget: no generic word-soup (`abc`),
        // namespace/signature columns, locality bonus on top of our sortText.
        suggest: {
          showStatusBar: true,
          showWords: false,        // kill `abc php`/`abc public` word completions
          showInlineDetails: true, // signature inline after the label
          localityBonus: true,     // nearby symbols float up (additive to sortText)
        },
        wordBasedSuggestions: 'off',
        inlayHints: { enabled: 'onUnlessPressed' },
        // Navigation behaviour for Ctrl+Click on a symbol.
        //   - definitions:        goto first result immediately. The
        //                         default `'peek'` shows an inline popup
        //                         and double-click on a row is supposed
        //                         to open the file — that round-trip
        //                         through Monaco's reference search
        //                         widget doesn't fire our editor opener
        //                         consistently, so the user perceives
        //                         the navigation as broken. `'goto'`
        //                         skips the popup entirely and our
        //                         opener fires every time.
        //   - type definitions:   same reasoning.
        //   - implementations:    keep `'gotoAndPeek'` — usually 1, but
        //                         when N>1 the peek list is useful.
        //   - references:         `'view'` opens the references view
        //                         instead of inline peek (still a popup
        //                         but a more reliable widget on
        //                         double-click). If we wire a dedicated
        //                         References pane later, switch to a
        //                         custom action.
        gotoLocation: {
          multipleDefinitions: 'goto',
          multipleTypeDefinitions: 'goto',
          multipleImplementations: 'gotoAndPeek',
          multipleReferences: 'gotoAndPeek',
          multipleDeclarations: 'goto',
        },
      }}
    />
  );
}
