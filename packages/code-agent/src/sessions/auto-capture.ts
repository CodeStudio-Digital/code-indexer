/**
 * Auto-captured session notes — cheap, LLM-free hooks that write durable
 * working-memory notes (`coder_session_memory`) at key lifecycle events, so
 * the Session State Block stays useful even when the model never calls
 * `save_note` on its own (the old opt-in-only failure mode).
 *
 * Anti-pollution by design:
 *   - canonical titles + the table's UNIQUE(session_id, title) upsert →
 *     re-events UPDATE the same note instead of stacking copies;
 *   - `kind` carries an `auto:` prefix so `memoryForState` can cap how many
 *     auto notes enter the block (they never evict deliberate notes);
 *   - only four events qualify: plan approved, goal completed, task closed
 *     with a summary, and an error-streak finally resolving. Volatile state
 *     (todo updates, unapproved plans) is deliberately NOT captured.
 *
 * Every sink is best-effort: a failed write must never affect the turn.
 */

export interface AutoCaptureStore {
  rememberMemory(
    sessionId: number,
    input: { title: string; body: string; kind?: string; pinned?: boolean },
  ): { title: string };
}

export interface AutoCapture {
  onPlanResolved(status: string, planText: string | null, feedback?: string): void;
  onGoalUpserted(goal: { text: string; status: string; completionNote?: string | null }): void;
  onTaskStatus(
    taskId: string,
    patch: {
      status?: string;
      result?: { summary?: string; files_modified?: string[]; errors?: string } | null;
    },
  ): void;
  onToolResult(name: string, isError: boolean, errorSnippet: string, turn: number): void;
}

/** Consecutive failures of the same tool before a success mints a note. */
const FIX_STREAK_THRESHOLD = 3;

function excerpt(text: string, cap: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > cap ? `${collapsed.slice(0, cap)}…` : collapsed;
}

const NOOP: AutoCapture = {
  onPlanResolved: () => undefined,
  onGoalUpserted: () => undefined,
  onTaskStatus: () => undefined,
  onToolResult: () => undefined,
};

export function buildAutoCapture(args: {
  store: AutoCaptureStore;
  sessionId: number;
  enabled: boolean;
  /** Polling/repeatable tools fail-then-succeed by design — exempt from streak notes. */
  isRepeatable?: (toolName: string) => boolean;
}): AutoCapture {
  if (!args.enabled) return NOOP;
  const { store, sessionId } = args;

  const save = (input: { title: string; body: string; kind: string; pinned?: boolean }): void => {
    try {
      store.rememberMemory(sessionId, input);
    } catch {
      /* auto-capture must never break the turn */
    }
  };

  // Error-streak tracker: toolName → { count, lastError }.
  const streaks = new Map<string, { count: number; lastError: string }>();

  return {
    onPlanResolved(status, planText, feedback) {
      if (status !== 'approved' || !planText) return;
      const fb = feedback?.trim() ? ` User feedback: ${excerpt(feedback, 200)}` : '';
      save({
        title: 'Approved plan',
        body: `${excerpt(planText, 300)}${fb}`,
        kind: 'auto:plan',
      });
    },

    onGoalUpserted(goal) {
      // Goal creation is already structural (goal_* columns render in the
      // state block live) — only COMPLETION is a durable fact worth a note.
      if (goal.status !== 'complete' || !goal.text) return;
      const note = goal.completionNote?.trim() ? ` — ${excerpt(goal.completionNote, 160)}` : '';
      save({
        title: 'Goal completed',
        body: `${excerpt(goal.text, 200)}${note}`,
        kind: 'auto:goal',
      });
    },

    onTaskStatus(taskId, patch) {
      const status = patch.status;
      if (status !== 'done' && status !== 'failed') return;
      const summary = patch.result?.summary?.trim();
      if (!summary) return; // a closure without a summary carries no signal
      const files = (patch.result?.files_modified ?? []).slice(0, 5);
      const filesLine = files.length ? ` Files: ${files.join(', ')}` : '';
      save({
        title: `Task ${taskId}`,
        body: `${status}: ${excerpt(summary, 240)}${filesLine}`,
        kind: 'auto:task',
      });
    },

    onToolResult(name, isError, errorSnippet, turn) {
      if (args.isRepeatable?.(name)) return;
      const cur = streaks.get(name);
      if (isError) {
        streaks.set(name, {
          count: (cur?.count ?? 0) + 1,
          lastError: errorSnippet || cur?.lastError || '',
        });
        return;
      }
      streaks.delete(name);
      if (cur && cur.count >= FIX_STREAK_THRESHOLD) {
        save({
          title: `Fixed: ${name}`,
          body:
            `After ${cur.count} consecutive failures, ${name} succeeded (turn ${turn}).` +
            (cur.lastError ? ` Last error: ${excerpt(cur.lastError, 160)}` : ''),
          kind: 'auto:fix',
        });
      }
    },
  };
}
