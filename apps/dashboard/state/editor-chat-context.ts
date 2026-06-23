/**
 * Editor → chat context bridge (Copilot-style rail).
 *
 * Single source of truth for the context the user stages from the Monaco
 * editor before sending it to the editor chat rail:
 *   - `fileRefs`: whole-file references (sticky — survive switching the
 *     active file; cleared after a send). The rail feeds these into the
 *     Composer as `filePicks`, so they ride along as a `<file_refs>` block.
 *   - `selections`: captured code snippets (path + line range + text). The
 *     rail prepends them as `<selected-code …>` blocks on send.
 *
 * Keyed by `projectId` so two open projects never cross-contaminate. The
 * Monaco actions write here from outside React (`getState().addX(...)`),
 * the rail reads reactively via `useEditorChatContext`. Mirrors the module
 * store pattern of `pending-reveal.ts` / `studio-context-store.ts`, but kept
 * separate on purpose: `studio-context-store` is typed for DOM element
 * selections and already consumed by AgentChat's builder path.
 */
import { create } from 'zustand';

export interface CodeSelection {
  /** Stable identity for dedup/removal: `path:startLine-endLine`. */
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

interface ProjectContext {
  fileRefs: string[];
  selections: CodeSelection[];
}

const EMPTY: ProjectContext = { fileRefs: [], selections: [] };

/** Max characters captured per selection — guards against pasting a huge
 *  range into every outgoing prompt. */
export const MAX_SELECTION_CHARS = 8000;

export function selectionId(path: string, startLine: number, endLine: number): string {
  return `${path}:${startLine}-${endLine}`;
}

interface EditorChatContextState {
  byProject: Record<number, ProjectContext>;
  /**
   * The CURRENT editor selection per project (Copilot-style live chip),
   * tracked from Monaco's selection events. Ephemeral — reflects whatever is
   * selected right now; `null` when nothing is selected. Distinct from the
   * pinned `selections` (Ctrl/Cmd+I) which accumulate.
   */
  liveSelectionByProject: Record<number, CodeSelection | null>;

  addFileRef: (projectId: number, path: string) => void;
  removeFileRef: (projectId: number, path: string) => void;
  toggleFileRef: (projectId: number, path: string) => void;
  clearFileRefs: (projectId: number) => void;

  addSelection: (projectId: number, sel: Omit<CodeSelection, 'id'>) => void;
  removeSelection: (projectId: number, id: string) => void;
  clearSelections: (projectId: number) => void;

  /** Set/replace the live editor selection (or `null` to clear it). */
  setLiveSelection: (projectId: number, sel: Omit<CodeSelection, 'id'> | null) => void;

  /** Drop everything staged for the project (called after a successful send). */
  clear: (projectId: number) => void;
}

function ctx(map: Record<number, ProjectContext>, projectId: number): ProjectContext {
  return map[projectId] ?? EMPTY;
}

export const useEditorChatContextStore = create<EditorChatContextState>((set) => ({
  byProject: {},
  liveSelectionByProject: {},

  addFileRef: (projectId, path) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      if (cur.fileRefs.includes(path)) return s;
      return {
        byProject: { ...s.byProject, [projectId]: { ...cur, fileRefs: [...cur.fileRefs, path] } },
      };
    }),

  removeFileRef: (projectId, path) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      if (!cur.fileRefs.includes(path)) return s;
      return {
        byProject: {
          ...s.byProject,
          [projectId]: { ...cur, fileRefs: cur.fileRefs.filter((p) => p !== path) },
        },
      };
    }),

  toggleFileRef: (projectId, path) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      const next = cur.fileRefs.includes(path)
        ? cur.fileRefs.filter((p) => p !== path)
        : [...cur.fileRefs, path];
      return { byProject: { ...s.byProject, [projectId]: { ...cur, fileRefs: next } } };
    }),

  clearFileRefs: (projectId) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      if (cur.fileRefs.length === 0) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...cur, fileRefs: [] } } };
    }),

  addSelection: (projectId, sel) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      const id = selectionId(sel.path, sel.startLine, sel.endLine);
      const text = sel.text.length > MAX_SELECTION_CHARS ? sel.text.slice(0, MAX_SELECTION_CHARS) : sel.text;
      const entry: CodeSelection = { ...sel, text, id };
      // Dedup by id: re-selecting the same range replaces (idempotent).
      const rest = cur.selections.filter((x) => x.id !== id);
      return {
        byProject: { ...s.byProject, [projectId]: { ...cur, selections: [...rest, entry] } },
      };
    }),

  removeSelection: (projectId, id) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      if (!cur.selections.some((x) => x.id === id)) return s;
      return {
        byProject: {
          ...s.byProject,
          [projectId]: { ...cur, selections: cur.selections.filter((x) => x.id !== id) },
        },
      };
    }),

  clearSelections: (projectId) =>
    set((s) => {
      const cur = ctx(s.byProject, projectId);
      if (cur.selections.length === 0) return s;
      return { byProject: { ...s.byProject, [projectId]: { ...cur, selections: [] } } };
    }),

  setLiveSelection: (projectId, sel) =>
    set((s) => {
      const cur = s.liveSelectionByProject[projectId] ?? null;
      if (sel == null) {
        if (cur == null) return s;
        return { liveSelectionByProject: { ...s.liveSelectionByProject, [projectId]: null } };
      }
      const id = selectionId(sel.path, sel.startLine, sel.endLine);
      const text = sel.text.length > MAX_SELECTION_CHARS ? sel.text.slice(0, MAX_SELECTION_CHARS) : sel.text;
      // Churn guard compares text too: the id only encodes the LINE range, so a
      // same-line column change (extend/shrink within a line) keeps the id but
      // must still refresh the captured text — otherwise the chip/send go stale.
      if (cur && cur.id === id && cur.text === text) return s;
      return { liveSelectionByProject: { ...s.liveSelectionByProject, [projectId]: { ...sel, text, id } } };
    }),

  clear: (projectId) =>
    set((s) => {
      const hadProject = !!s.byProject[projectId];
      const hadLive = s.liveSelectionByProject[projectId] != null;
      if (!hadProject && !hadLive) return s;
      const next = { ...s.byProject };
      delete next[projectId];
      return {
        byProject: next,
        liveSelectionByProject: { ...s.liveSelectionByProject, [projectId]: null },
      };
    }),
}));

/** Reactive per-project slice for the rail. Stable empty fallback so an
 *  untouched project doesn't churn re-renders. */
export function useEditorChatContext(projectId: number): ProjectContext {
  return useEditorChatContextStore((s) => s.byProject[projectId] ?? EMPTY);
}

/** Reactive live editor selection for the project (Copilot "current selection" chip). */
export function useLiveSelection(projectId: number): CodeSelection | null {
  return useEditorChatContextStore((s) => s.liveSelectionByProject[projectId] ?? null);
}

/** Imperative accessor for the Monaco actions (write from outside React). */
export function editorChatContextActions() {
  return useEditorChatContextStore.getState();
}

/** Format staged selections as `<selected-code>` blocks for the outgoing
 *  message prefix. Pure — empty string when there are none. */
export function formatSelections(selections: CodeSelection[]): string {
  if (!selections.length) return '';
  return selections
    .map(
      (s) =>
        `<selected-code path="${s.path}" lines="${s.startLine}-${s.endLine}">\n${s.text}\n</selected-code>`,
    )
    .join('\n');
}
