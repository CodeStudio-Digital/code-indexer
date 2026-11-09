/**
 * Session State Block — the "always alive" structured state of a session,
 * derived from PERSISTED data (plan, todos, notes, file map), never
 * from LLM summarization. Injected as a `<session-state>` tail block so a
 * model — especially a short-window one — keeps its bearings regardless of
 * how aggressively older turns were compacted.
 *
 * Pure + deterministic: same data + budget → same string (tests pin it).
 * The injection POLICY (when/how big) lives in `injection-policy.ts`; the
 * dedup (hash) lives in the dynamic injector.
 */
import { createHash } from 'node:crypto';

/** Structural shape produced by `SessionStore.getSessionStateData`. */
export interface SessionStateData {
  activePlan: { text: string; status: string } | null;
  todos: ReadonlyArray<{ status: string; label: string }>;
  notes: ReadonlyArray<{ id: string; title: string; body: string; kind: string; pinned: boolean }>;
  filesChanged: ReadonlyArray<string>;
  investigationCount: number;
}

export interface SessionStateBudget {
  /** Plan excerpt chars (0 hides the plan line). */
  planChars: number;
  /** Max notes shown. */
  noteSlots: number;
  /** Chars per note body. */
  noteChars: number;
  /** Max todo lines (0 hides; also hidden when includeLiveState=false). */
  todoLines: number;
  /** Max files_changed entries (0 hides). */
  fileSlots: number;
  /**
   * False when the `<active-context>` block (Agent Loop v2) already carries
   * todos every turn — the state block then omits them to avoid double
   * injection and keeps only plan/notes/files/recall.
   */
  includeLiveState: boolean;
}

const ELLIPSIS = '…';

function excerpt(text: string, cap: number): string {
  const collapsed = text.replace(/\s*\n\s*/g, ' ').trim();
  return collapsed.length > cap ? `${collapsed.slice(0, cap)}${ELLIPSIS}` : collapsed;
}

/**
 * Render the block. Empty sections are omitted; returns null when nothing
 * material exists (a brand-new session produces no block at all).
 */
export function renderSessionStateBlock(
  data: SessionStateData,
  budget: SessionStateBudget,
): string | null {
  const lines: string[] = [];

  if (budget.planChars > 0 && data.activePlan?.text) {
    lines.push(
      `plan [${data.activePlan.status}]: ${excerpt(data.activePlan.text, budget.planChars)} ` +
      '(call read_plan for full text)',
    );
  }

  if (budget.includeLiveState && budget.todoLines > 0 && data.todos.length > 0) {
    // Unfinished first; a single trailing completed line keeps progress visible.
    const unfinished = data.todos.filter((t) => t.status !== 'completed');
    const done = data.todos.filter((t) => t.status === 'completed');
    const shown = [...unfinished.slice(0, budget.todoLines), ...done.slice(-1)].slice(0, budget.todoLines);
    if (shown.length > 0) {
      lines.push('todos:');
      for (const t of shown) lines.push(`  - [${t.status}] ${excerpt(t.label, 100)}`);
      const hidden = data.todos.length - shown.length;
      if (hidden > 0) lines.push(`  (+${hidden} more)`);
    }
  }

  if (budget.noteSlots > 0 && data.notes.length > 0) {
    const shown = data.notes.slice(0, budget.noteSlots);
    lines.push('notes:');
    for (const n of shown) {
      const pin = n.pinned ? '📌 ' : '';
      lines.push(`  - ${pin}[${n.kind}] ${n.title}: ${excerpt(n.body, budget.noteChars)}`);
    }
  }

  if (budget.fileSlots > 0 && data.filesChanged.length > 0) {
    const shown = data.filesChanged.slice(0, budget.fileSlots);
    const extra = data.filesChanged.length > shown.length
      ? ` (+${data.filesChanged.length - shown.length} more)`
      : '';
    lines.push(`files_changed: ${shown.join(', ')}${extra}`);
  }

  if (data.investigationCount > 0) {
    lines.push(
      `recall: ${data.investigationCount} prior investigation(s) saved — ` +
      'call recall_investigations before re-exploring.',
    );
  }

  if (lines.length === 0) return null;
  return `<session-state>\n${lines.join('\n')}\n</session-state>`;
}

/** Stable short hash for dedup ("re-inject only when the block changed"). */
export function hashSessionState(rendered: string): string {
  return createHash('sha1').update(rendered).digest('hex').slice(0, 12);
}

/**
 * Render the project memory index (MEMORY.md-style): top-N one-liners so
 * every session knows WHAT this project has learned; full bodies come via
 * `recall_memory`. Returns null when empty or maxChars=0.
 */
export function renderMemoryIndex(
  entries: ReadonlyArray<{ title: string; category: string }>,
  maxChars: number,
): string | null {
  if (maxChars <= 0 || entries.length === 0) return null;
  const header =
    'project memory index (titles only — call recall_memory({query}) for full content):';
  const lines: string[] = [header];
  let used = header.length;
  for (const e of entries) {
    const line = `- [${e.category}] ${excerpt(e.title, 90)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

/**
 * Render the session-scoped conversation chapter table of contents. Only titles
 * are injected; full summaries and source messages stay behind the
 * `recall_conversation` tool so prompt cost remains bounded as the session grows.
 */
export function renderConversationChapterIndex(
  entries: ReadonlyArray<{ id: string; ordinal: number; title: string; source?: string }>,
  total: number,
  maxChars: number,
): string | null {
  if (maxChars <= 0 || entries.length === 0) return null;
  const open = '<conversation-chapters>\n';
  const close = '\n</conversation-chapters>';
  const innerBudget = Math.max(0, maxChars - open.length - close.length);
  const header =
    `conversation chapters (${total} total; titles only — call recall_conversation to search/read/source):`;
  if (header.length >= innerBudget) return null;
  const lines: string[] = [header];
  let used = header.length;
  for (const entry of entries.slice(0, 10)) {
    const source = entry.source ? ` · ${entry.source}` : '';
    const line = `- #${entry.ordinal} [id=${entry.id}${source}] ${excerpt(entry.title, 100)}`;
    if (used + line.length + 1 > innerBudget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? `${open}${lines.join('\n')}${close}` : null;
}

/**
 * Render the GLOBAL user-preferences block (migration 145): who the user is +
 * how they want the agent to work, applied to EVERY project. Unlike the
 * project index this carries short bodies (the preference itself is the
 * payload, not a pointer). Returns null when empty or maxChars=0.
 */
export function renderUserMemoryBlock(
  entries: ReadonlyArray<{ title: string; category?: string; excerpt?: string }>,
  maxChars: number,
): string | null {
  if (maxChars <= 0 || entries.length === 0) return null;
  const open = '<user-preferences>\n';
  const close = '\n</user-preferences>';
  const budget = maxChars - open.length - close.length;
  const header = 'user preferences (global; recall_memory with scope:"user" for details):';
  if (budget <= header.length + 4) return null;
  const lines: string[] = [header];
  let used = header.length;
  for (const e of entries) {
    const detail = e.excerpt ? `: ${excerpt(e.excerpt, 160)}` : '';
    const remaining = budget - used - 1;
    if (remaining < 5) break;
    const line = excerpt(`- ${excerpt(e.title, 90)}${detail}`, remaining - 1);
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 1 ? `${open}${lines.join('\n')}${close}` : null;
}
