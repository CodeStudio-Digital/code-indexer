/**
 * State machine of the visual-edit panel: selection → optimistic DOM op
 * (postMessage into the preview) → debounced POST to the deterministic
 * rewrite endpoint → chained `newLoc`/`fileHash` for the next edit.
 *
 * Concurrency rules: edits are blocked while the agent is busy (one
 * writer at a time) and while the target file sits dirty in Monaco. A
 * 409 from the server means the file moved under us → the selection is
 * marked stale and the user re-picks; a 422 means "this shape needs the
 * agent" → the reason is surfaced inline.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ParentToPreviewMessage } from '@mcp/services/sandbox/builder/protocol.js';
import { apiPost } from '../../../../hooks/useApi.js';
import { useWorkspaceStore } from '../../../../state/workspace.js';
import {
  getSelected,
  isAgentBusy,
  selectionKey,
  subscribeSelected,
  updateSelected,
  type SelectedElement,
} from '../studio-context-store.js';

const DEBOUNCE_MS = 300;
const BUSY_POLL_MS = 1500;
// A burst of visual edits settles into ONE checkpoint commit after this
// quiet window — keeps the timeline meaningful instead of per-click noise.
const CHECKPOINT_DEBOUNCE_MS = 30_000;

interface VisualEditResponse {
  ok: true;
  newLoc: string;
  fileHash: string;
}

export interface UseVisualEditOptions {
  /** Post a message into the preview iframe (origin-checked by the caller). */
  postToPreview: (msg: ParentToPreviewMessage) => void;
  /** Preview origin — inbound `message` events are filtered against it. */
  origin: string;
  /** Master switch: stamped iframe visible (not popped out / agent preview). */
  enabled: boolean;
}

export function useVisualEdit(projectId: number, opts: UseVisualEditOptions) {
  const selected = useSelectedElement(projectId);
  const [classes, setClasses] = useState<string[]>([]);
  const [locCount, setLocCount] = useState(1);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  /**
   * Whether the preview answered `mcp:query-loc` — projects scaffolded
   * before the edit runtime shipped never reply, so optimistic DOM ops
   * and inline text editing are silently dead there until the user runs
   * the repair (Wrench). null = still probing.
   */
  const [runtimeReady, setRuntimeReady] = useState<boolean | null>(null);
  const agentBusy = useAgentBusyPoll(projectId);
  // Chained edit identity — server responses move these forward.
  const locRef = useRef<string | null>(null);
  const fileHashRef = useRef<string | null>(null);
  const undoStack = useRef<string[][]>([]);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkpointRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // (Re-)seed local state whenever the user picks a new element. The
  // query-loc probe doubles as the edit-runtime handshake: no reply in
  // 2.5s → old preview tooling (pre-edit-runtime) → surface the repair hint.
  useEffect(() => {
    setClasses(selected?.classes ?? []);
    setRefusal(null);
    setStale(false);
    setRuntimeReady(null);
    locRef.current = selected?.loc || null;
    fileHashRef.current = null;
    undoStack.current = [];
    if (selected?.loc) {
      optsRef.current.postToPreview({ type: 'mcp:query-loc', loc: selected.loc });
      const probe = setTimeout(() => setRuntimeReady((cur) => (cur === null ? false : cur)), 2500);
      return () => clearTimeout(probe);
    }
    setLocCount(1);
  }, [selected?.loc]);

  /**
   * POST one op; resolves chained identity, classifies refusals. When
   * `revertClasses` is given, a failure rolls the optimistic DOM/state
   * back so the preview never lies about what is on disk.
   */
  const commit = useCallback(
    async (
      op: { kind: 'set-classes'; classes: string } | { kind: 'set-text'; text: string },
      revertClasses?: string[],
    ) => {
      const loc = locRef.current;
      const sel = getSelected(projectId);
      if (!loc) return;
      try {
        const res = await apiPost<VisualEditResponse>(`/projects/${projectId}/builder/visual-edit`, {
          loc,
          op,
          expectTag: sel?.tag,
          ...(fileHashRef.current ? { expectFileHash: fileHashRef.current } : {}),
        });
        locRef.current = res.newLoc;
        fileHashRef.current = res.fileHash;
        setRefusal(null);
        // Settle the burst into one "Visual edits" checkpoint commit.
        if (checkpointRef.current) clearTimeout(checkpointRef.current);
        checkpointRef.current = setTimeout(() => {
          void apiPost(`/projects/${projectId}/checkpoints`, {
            label: 'Visual edits',
            kind: 'visual',
          }).catch(() => undefined);
        }, CHECKPOINT_DEBOUNCE_MS);
        // Keep the chip/prompt prefix in sync when the rewrite shifted lines —
        // patch just THIS element (by its pre-rewrite key) so other multi-select
        // citations survive an edit to one of them.
        if (sel && sel.loc !== res.newLoc) {
          updateSelected(projectId, selectionKey(sel), {
            loc: res.newLoc,
            ...(op.kind === 'set-classes'
              ? { classes: op.classes.split(/\s+/).filter(Boolean) }
              : {}),
          });
        }
      } catch (e) {
        // Roll the optimistic change back FIRST — whatever the failure,
        // the preview must reflect what is actually on disk.
        if (revertClasses && locRef.current) {
          setClasses(revertClasses);
          optsRef.current.postToPreview({
            type: 'mcp:set-classes',
            loc: locRef.current,
            classes: revertClasses,
          });
        }
        const status = (e as { status?: number }).status;
        if (status === 409) {
          setStale(true);
          setRefusal('Selection went stale — re-pick the element.');
        } else if (status === 404) {
          setRefusal('Backend has no visual-edit endpoint — restart the app to load the new backend.');
        } else {
          setRefusal(e instanceof Error ? e.message.replace(/^HTTP \d+: /, '') : 'edit failed');
        }
      }
    },
    [projectId],
  );

  // Inbound preview messages: instance count + committed inline text.
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (!optsRef.current.origin || ev.origin !== optsRef.current.origin) return;
      const d = ev.data as { type?: string; loc?: string; count?: number; text?: string } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === 'mcp:loc-count' && d.loc && d.loc === locRef.current) {
        setRuntimeReady(true);
        setLocCount(typeof d.count === 'number' && d.count > 0 ? d.count : 1);
      } else if (d.type === 'mcp:text-committed' && typeof d.text === 'string' && d.loc) {
        void commit({ kind: 'set-text', text: d.text });
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [commit]);

  const targetPath = selected?.loc ? selected.loc.replace(/:\d+:\d+$/, '') : null;
  const dirtyInEditor = useWorkspaceStore((s) =>
    targetPath != null &&
    s.openFiles.some((f) => f.path === targetPath && f.kind !== 'diff' && (f as { dirty?: boolean }).dirty === true),
  );

  const canEdit = opts.enabled && !!selected?.loc && !agentBusy && !dirtyInEditor && !stale;

  /** Optimistic class update: instant DOM swap + debounced source write. */
  const applyClasses = useCallback(
    (next: string[]) => {
      if (!locRef.current) return;
      const before = classes;
      undoStack.current = [...undoStack.current.slice(-19), before];
      setClasses(next);
      optsRef.current.postToPreview({ type: 'mcp:set-classes', loc: locRef.current, classes: next });
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        void commit({ kind: 'set-classes', classes: next.join(' ') }, before);
      }, DEBOUNCE_MS);
    },
    [classes, commit],
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev || !locRef.current) return;
    const before = classes;
    setClasses(prev);
    optsRef.current.postToPreview({ type: 'mcp:set-classes', loc: locRef.current, classes: prev });
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void commit({ kind: 'set-classes', classes: prev.join(' ') }, before);
    }, DEBOUNCE_MS);
  }, [classes, commit]);

  const beginTextEdit = useCallback(() => {
    if (locRef.current) {
      optsRef.current.postToPreview({ type: 'mcp:begin-text-edit', loc: locRef.current });
    }
  }, []);

  return {
    selected,
    classes,
    locCount,
    refusal,
    canEdit,
    agentBusy,
    dirtyInEditor,
    runtimeReady,
    canUndo: undoStack.current.length > 0,
    applyClasses,
    undo,
    beginTextEdit,
  };
}

/** Reactive-ish busy flag — the store has no subscription, so poll it. */
function useAgentBusyPoll(projectId: number): boolean {
  const [busy, setBusy] = useState(() => isAgentBusy(projectId));
  useEffect(() => {
    setBusy(isAgentBusy(projectId));
    const id = setInterval(() => setBusy(isAgentBusy(projectId)), BUSY_POLL_MS);
    return () => clearInterval(id);
  }, [projectId]);
  return busy;
}

/** Subscribe to the module store for this project's current selection. */
function useSelectedElement(projectId: number): SelectedElement | null {
  const [sel, setSel] = useState<SelectedElement | null>(() => getSelected(projectId));
  useEffect(() => {
    setSel(getSelected(projectId));
    return subscribeSelected(projectId, () => setSel(getSelected(projectId)));
  }, [projectId]);
  return sel;
}
