/**
 * Glue Monaco ⇆ nav-history + comandos do registry global:
 *   navigate.back / navigate.forward   — Ctrl+Alt+Left/Right (IntelliJ),
 *                                        Alt+Left/Right (VS Code)
 *   editor.nextChange / editor.prevChange — Ctrl+Alt+Shift+Down/Up, pulando
 *                                        entre change-markers (wrap-around)
 *
 * Push points do histórico:
 *   - `attachNavTracking` (MonacoMount): salto de cursor >10 linhas (debounce
 *     300ms), troca de modelo (tab no mesmo editor) e dispose do editor
 *     (remount por content:null) empilham a posição que está sendo DEIXADA.
 *   - `pushCurrentNavPosition` (opener do LSP): antes de abrir o destino.
 *
 * Saltos PROGRAMÁTICOS (back/forward/goto) suprimem o tracking por uma janela
 * curta — sem isso, o próprio navBack dispararia um push (>10 linhas) que
 * limparia a pilha forward.
 *
 * NB dispatcher: o keydown é consumido quando o binding casa (preventDefault
 * antes do run), então com histórico vazio o comando é apenas no-op — segue
 * rebindável no KeymapDialog caso Ctrl+Alt+Left/Right colida com hotkey de
 * driver de vídeo. Bindings na ordem de token do dispatcher (Ctrl,Alt,Shift).
 */
import type * as MonacoNs from 'monaco-editor';
import { registerCommandHandlers } from '../../../keymap/commands.js';
import { useWorkspaceStore } from '../../../state/workspace.js';
import { getActiveEditor } from './editor-models.js';
import { parseModelPath } from './editor-models-path.js';
import { setPendingReveal } from './pending-reveal.js';
import { pushNavEntry, navBack, navForward, resetOnProject, type NavEntry } from './nav-history.js';
import { getChangeRanges } from './change-markers/attach-change-tracker.js';
import { anchorLine } from './change-markers/diff-to-changes.js';

type CodeEditor = MonacoNs.editor.IStandaloneCodeEditor;

const CURSOR_DEBOUNCE_MS = 300;
const JUMP_LINES = 10;
const SUPPRESS_MS = 800;

let suppressUntil = 0;
const suppressTracking = (): void => { suppressUntil = Date.now() + SUPPRESS_MS; };
const suppressed = (): boolean => Date.now() < suppressUntil;

/** Posição atual do editor como NavEntry (null: sem modelo/posição/projeto). */
function entryAt(editor: CodeEditor): NavEntry | null {
  try {
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return null;
    const { projectId, relPath } = parseModelPath(model.uri.path);
    const pid = projectId ?? useWorkspaceStore.getState().activeProjectId;
    if (pid === null) return null;
    return { projectId: pid, path: relPath, line: pos.lineNumber, column: pos.column };
  } catch {
    return null; // editor disposed sob o timer do debounce
  }
}

export function currentNavPosition(): NavEntry | null {
  const editor = getActiveEditor();
  return editor ? entryAt(editor) : null;
}

/** Opener do LSP: registra a posição ANTES do salto (e suprime o eco mecânico). */
export function pushCurrentNavPosition(): void {
  const entry = currentNavPosition();
  if (!entry) return;
  suppressTracking();
  pushNavEntry(entry);
}

/**
 * Tracking por editor (chamado no onMount do MonacoMount). Vida útil atada ao
 * editor via onDidDispose — o caller não precisa gerenciar o disposable.
 */
export function attachNavTracking(editor: CodeEditor): void {
  let last: NavEntry | null = entryAt(editor);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const settle = (): void => {
    timer = null;
    const now = entryAt(editor);
    if (!now) return;
    if (!suppressed() && last &&
        (last.path !== now.path || last.projectId !== now.projectId ||
         Math.abs(last.line - now.line) > JUMP_LINES)) {
      pushNavEntry(last);
    }
    last = now;
  };

  editor.onDidChangeCursorPosition(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(settle, CURSOR_DEBOUNCE_MS);
  });
  // Troca de aba no MESMO editor (keepCurrentModel): registra o arquivo que
  // está sendo deixado imediatamente — o debounce leria o modelo NOVO dos
  // dois lados da comparação.
  editor.onDidChangeModel(() => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (last && !suppressed()) pushNavEntry(last);
    last = entryAt(editor);
  });
  // Remount (aba com content:null desmonta o <Editor>): flush da última
  // posição conhecida para que "voltar" alcance a aba deixada.
  editor.onDidDispose(() => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (last && !suppressed()) pushNavEntry(last);
    last = null;
  });
}

/** Navega até a entry: mesmo arquivo → setPosition direto; senão abre a aba
 *  via workspace store + pending-reveal (o MESMO fluxo do opener do LSP). */
function goToEntry(target: NavEntry): void {
  suppressTracking();
  const store = useWorkspaceStore.getState();
  if (store.activeProjectId !== null && store.activeProjectId !== target.projectId) return;
  const editor = getActiveEditor();
  const model = editor?.getModel();
  const parsed = model ? parseModelPath(model.uri.path) : null;
  if (editor && parsed && parsed.relPath === target.path) {
    editor.setPosition({ lineNumber: target.line, column: target.column });
    editor.revealLineInCenter(target.line);
    editor.focus();
    return;
  }
  setPendingReveal(target.path, { line: target.line, column: target.column });
  const existing = store.openFiles.find(
    (f) => f.path === target.path && f.projectId === target.projectId,
  );
  if (existing) {
    store.setActive(target.path);
  } else {
    store.openFile({
      kind: 'file', projectId: target.projectId, path: target.path,
      content: null, dirty: false, lastModified: null,
    });
  }
}

/** Public jump used by IDE affordances (usages, implementations, search). */
export function navigateToProjectLocation(target: NavEntry): void {
  pushCurrentNavPosition();
  goToEntry(target);
}

/** Próximo/anterior change-marker do modelo ativo, com wrap-around. */
function jumpChange(dir: 1 | -1): void {
  const editor = getActiveEditor();
  const model = editor?.getModel();
  if (!editor || !model) return;
  const changes = getChangeRanges(model.uri.path.replace(/^\//, ''));
  if (changes.length === 0) return;
  const lineCount = model.getLineCount();
  const cur = editor.getPosition()?.lineNumber ?? 1;
  const anchors = changes.map((c) => anchorLine(c, lineCount));
  const target =
    dir === 1
      ? anchors.find((l) => l > cur) ?? anchors[0]
      : [...anchors].reverse().find((l) => l < cur) ?? anchors[anchors.length - 1];
  editor.setPosition({ lineNumber: target, column: 1 });
  editor.revealLineInCenter(target);
  editor.focus();
}

export function registerNavCommands(): () => void {
  // Troca de projeto invalida o histórico do projeto que sai (as abas dele
  // acabaram de ser dropadas pelo setProject).
  let lastProject = useWorkspaceStore.getState().activeProjectId;
  const unsubscribe = useWorkspaceStore.subscribe((s) => {
    if (s.activeProjectId === lastProject) return;
    lastProject = s.activeProjectId;
    if (lastProject !== null) resetOnProject(lastProject);
  });
  const unregister = registerCommandHandlers([
    {
      id: 'navigate.back',
      run: () => {
        const target = navBack(currentNavPosition());
        if (target) goToEntry(target);
      },
    },
    {
      id: 'navigate.forward',
      run: () => {
        const target = navForward(currentNavPosition());
        if (target) goToEntry(target);
      },
    },
    {
      id: 'editor.nextChange',
      run: () => jumpChange(1),
    },
    {
      id: 'editor.prevChange',
      run: () => jumpChange(-1),
    },
  ]);
  return () => {
    unsubscribe();
    unregister();
  };
}
