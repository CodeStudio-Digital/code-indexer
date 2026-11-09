/**
 * Per-session composer draft store. Keeps the in-progress message (text +
 * staged attachments) alive when the chat view unmounts on navigation — the
 * Composer's own `useState` dies with the component, but a module-level store
 * lives in the JS heap for the app's lifetime, so it survives.
 *
 * Mirrors the canonical session-keyed pattern of
 * `features/builder/studio/studio-context-store.ts` (Map + listener Set +
 * notify), but keyed by a NAMESPACED string (`coder:<id>` / `company:<id>`)
 * because coder-session and company-session ids live in different id spaces
 * and a bare number would collide.
 *
 * Persistence split: TEXT is mirrored to localStorage so it survives a full
 * reload/restart; ATTACHMENTS stay in memory only — a single base64 image can
 * be multiple MB and would blow the ~5 MB localStorage quota.
 */
import type { AgentAttachment } from '../../../hooks/agent-stream/types.js';

interface ComposerDraft {
  text: string;
  attachments: AgentAttachment[];
}

/** Returned by reference for any untouched key so it never churns identity. */
const EMPTY: ComposerDraft = { text: '', attachments: [] };

const draftByKey = new Map<string, ComposerDraft>();
const listeners = new Map<string, Set<() => void>>();
/** Keys already seeded from localStorage — hydrate is a one-shot per key. */
const hydratedKeys = new Set<string>();
const deletedKeys = new Set<string>();

const STORAGE_PREFIX = 'composerDraft:';

function isEmpty(d: ComposerDraft): boolean {
  return d.text.length === 0 && d.attachments.length === 0;
}

function notify(key: string): void {
  listeners.get(key)?.forEach((cb) => cb());
}

// ── localStorage (text only) ────────────────────────────────────────
// Accessed via `globalThis.localStorage` so a non-browser env (the vitest
// `node` environment) yields `undefined` instead of throwing a ReferenceError.

function readStoredText(key: string): string {
  try {
    return globalThis.localStorage?.getItem(STORAGE_PREFIX + key) ?? '';
  } catch {
    return '';
  }
}

function writeStoredText(key: string, text: string): void {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return;
    if (text.length === 0) ls.removeItem(STORAGE_PREFIX + key);
    else ls.setItem(STORAGE_PREFIX + key, text);
  } catch {
    /* quota exceeded / storage disabled — the in-memory copy still works */
  }
}

// ── Public API ──────────────────────────────────────────────────────

export function getDraft(key: string): ComposerDraft {
  return draftByKey.get(key) ?? EMPTY;
}

/**
 * Replace a key's draft. No-ops when nothing changed (identity short-circuit —
 * the anti-loop guard for the save↔notify↔adopt cycle). Deletes the entry when
 * the draft goes empty so only genuinely unsent drafts retain memory. Mirrors
 * the text to localStorage; attachments are never written to disk.
 */
export function setDraft(key: string, next: ComposerDraft): void {
  if (deletedKeys.has(key)) return; // a retained composer's unmount must not resurrect deleted text/images
  const cur = getDraft(key);
  if (cur.text === next.text && cur.attachments === next.attachments) return;
  if (next.text !== cur.text) writeStoredText(key, next.text);
  if (isEmpty(next)) draftByKey.delete(key);
  else draftByKey.set(key, next);
  notify(key);
}

/** Drop a key's draft entirely (memory + localStorage). Called on send. */
export function clearDraft(key: string): void {
  draftByKey.delete(key);
  writeStoredText(key, '');
  notify(key);
}

export function forgetDraft(key: string): void {
  deletedKeys.add(key);
  hydratedKeys.delete(key);
  clearDraft(key);
}

export function subscribeDraft(key: string, cb: () => void): () => void {
  let set = listeners.get(key);
  if (!set) listeners.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    set!.delete(cb);
  };
}

/**
 * Seed the in-memory store for `key` from localStorage the first time it's
 * read. In-memory always wins (a live draft is never clobbered by a stale
 * disk copy), and only text is restored — attachments don't survive a reload.
 */
export function hydrateFromStorageOnce(key: string): void {
  if (hydratedKeys.has(key)) return;
  hydratedKeys.add(key);
  if (draftByKey.has(key)) return;
  const text = readStoredText(key);
  if (text.length > 0) draftByKey.set(key, { text, attachments: [] });
}
