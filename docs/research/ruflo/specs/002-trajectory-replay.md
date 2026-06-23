# Spec 002 — Trajectory Replay (RETRIEVE / STORE)

**Effort:** M (3-5 days) · **ROI:** Medium-High · **Status:** Proposed
**Inspiration:** [ruflo-intelligence — 4-step pipeline](https://github.com/ruvnet/ruflo/blob/main/plugins/ruflo-intelligence/README.md)

---

## Problem

D:\MCP already captures session state in two places:
- [`packages/services/src/services/snapshots.ts`](../../../packages/services/src/services/snapshots.ts) — `ContextSnapshot` objects with title/content/embedding hash
- [`packages/code-agent/src/sessions/store.ts`](../../../packages/code-agent/src/sessions/store.ts) — `coder_sessions` table

But these are **passive** — used for dedup, diff viewing, and archival. When the user starts a new task, the coder agent does **not** retrieve similar past tasks. When the user finishes a task, the system does **not** store the trajectory (file sequence, tool calls, decision points) for future retrieval.

Result: D:\MCP repeats the same investigation, the same edits, and the same dead-ends. Users feel "Claude could remember this."

ruflo's pattern (whatever the SONA marketing): wrap each task with **RETRIEVE before** + **STORE after**. The actual learning ML is optional; the loop alone gives most of the value.

---

## Solution

Add a `TrajectoryStore` and two hook points in the coder agent lifecycle:

**On task start (RETRIEVE):**
1. Embed the user's task description.
2. LSH-search past successful trajectories for similar tasks (top-K, score > 0.7).
3. If found, inject as a `<related-past-tasks>` system message before the agent's first turn. (Optional: ask user "I've done this before. Apply same approach?")

**On task success (STORE):**
1. Collect the trajectory (task description, file paths touched, tool call sequence, verdict).
2. Generate a summary embedding.
3. Store in `trajectories` table with namespace `coder-trajectories`.

**On task failure:** STORE with verdict='failure' so future RETRIEVE can warn "I tried this; it didn't work because X."

---

## Files to touch / create

**Modify:**
- [`packages/code-agent/src/sessions/store.ts`](../../../packages/code-agent/src/sessions/store.ts) — add `recordTrajectory(session)` method called on session terminal state.
- [`packages/code-agent/src/core/messages.ts`](../../../packages/code-agent/src/core/messages.ts) — inject `<related-past-tasks>` before first user turn if RETRIEVE hits.
- [`packages/code-agent/src/sessions/types.ts`](../../../packages/code-agent/src/sessions/types.ts) — add `TrajectoryRecord` type.

**New:**
- `packages/code-agent/src/sessions/trajectory-store.ts` — `TrajectoryStore` class wrapping the new table + LSH index.
- `packages/code-agent/src/skills/trajectory-recall.md` — skill that teaches the agent how to use injected `<related-past-tasks>` blocks.
- `packages/store/src/migrations/096_trajectories.ts` — migration.

**Reuse:**
- `packages/indexer/src/search/lsh-index.ts` — same LSH for trajectory embeddings.
- Existing embedding provider in `packages/services/src/ai/` (don't add a new embedding model).

---

## Schema

Migration `096_trajectories.ts`:

```sql
CREATE TABLE trajectories (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,                 -- FK to coder_sessions.id
  project_id      TEXT,
  task_description TEXT NOT NULL,
  task_embedding  BLOB,                          -- 768-dim Float32Array
  verdict         TEXT NOT NULL,                  -- 'success' | 'failure' | 'partial'
  files_touched   TEXT NOT NULL,                 -- JSON array of paths
  tool_call_summary TEXT,                        -- JSON: [{ tool, count, total_ms }, ...]
  duration_ms     INTEGER,
  failure_reason  TEXT,                          -- non-null if verdict='failure'
  namespace       TEXT NOT NULL DEFAULT 'coder-trajectories',
  created_at      INTEGER NOT NULL,              -- unix ms
  UNIQUE(session_id)                             -- one trajectory per session
);

CREATE INDEX idx_trajectories_project ON trajectories(project_id, created_at DESC);
CREATE INDEX idx_trajectories_verdict ON trajectories(verdict, created_at DESC);
```

LSH index integrates via existing `packages/indexer/src/search/lsh-index.ts` with a new namespace key `coder-trajectories`.

---

## API

```typescript
// packages/code-agent/src/sessions/trajectory-store.ts
class TrajectoryStore {
  async record(session: SessionRecord, verdict: Verdict): Promise<TrajectoryRecord> {/* ... */}

  async retrieveSimilar(taskDescription: string, opts?: {
    projectId?: string,
    topK?: number,          // default 5
    minScore?: number,      // default 0.7
    onlyVerdicts?: Verdict[]  // default ['success']
  }): Promise<{ record: TrajectoryRecord, score: number }[]> {/* ... */}
}
```

Inject the RETRIEVE result in `messages.ts` before the first user message:

```typescript
// packages/code-agent/src/core/messages.ts (excerpt)
if (relatedPastTasks.length > 0) {
  systemMessages.push({
    role: "system",
    content: `<related-past-tasks count="${relatedPastTasks.length}">
${relatedPastTasks.map(r => `- [${r.score.toFixed(2)}] ${r.record.task_description} → ${r.record.verdict} (${r.record.files_touched.length} files)`).join("\n")}
</related-past-tasks>

Consider applying the same approach if the task is genuinely similar. If verdict was 'failure', avoid repeating the same dead-end.`
  });
}
```

The new `trajectory-recall.md` skill explains how to interpret this block.

---

## Tasks

| # | Task | Est |
|---|---|---|
| T1 | Migration `096_trajectories.ts` | 1h |
| T2 | `TrajectoryStore` class + LSH integration (reuse existing index) | 6h |
| T3 | Wire RETRIEVE into `messages.ts` (before first turn) | 4h |
| T4 | Wire STORE into `sessions/store.ts` (on terminal state) | 4h |
| T5 | Add `trajectory-recall.md` skill + register in skill registry | 1h |
| T6 | Dashboard: add "Past attempts" toggle on the chat input that shows the top-3 retrieved trajectories before user sends | 4h |
| T7 | Vitest: RETRIEVE returns correct items, STORE persists, integration test with embedding mock | 6h |
| T8 | Backfill script: for existing `coder_sessions` with `status='completed'`, generate trajectory records (one-shot) | 3h |
| T9 | Documentation: `docs/coder-agent/trajectories.md` | 2h |

**Total:** ~4 days

---

## Test plan

1. **Unit**: `TrajectoryStore.record/retrieveSimilar` with mocked LSH index. Assert namespace filter, verdict filter, topK + minScore.
2. **Integration**:
   - Run a task ("add a UUID validator"), let it complete with success → assert trajectory row exists with `verdict='success'`.
   - Start a new task with similar description → assert `<related-past-tasks>` block injected with score > 0.7.
   - Run a task that fails → assert `verdict='failure'` + `failure_reason` populated.
3. **Regression**:
   - Existing snapshot creation still works (don't double-write).
   - Sessions without any task description (edge case) skip trajectory record gracefully.
4. **Quality (manual)**:
   - Run 10 similar real tasks. Check qualitatively that RETRIEVE surfaces the right past attempts.
   - Tune `minScore` if too noisy or too sparse.
5. **Backfill**:
   - Run on a snapshot of prod DB with N sessions → assert N trajectory rows created without errors.

---

## Future enhancements (post-MVP)

- **JUDGE phase**: After STORE, run a small model to label trajectory quality (concise/verbose, decisive/wavering). Use as ranking signal.
- **DISTILL phase**: Periodically extract recurring patterns (e.g., "user always wants TS over JS for new files") and store as project-level preferences.
- **CONSOLIDATE phase**: Run as a `consolidate` background worker (per spec 001) — dedupe near-duplicate trajectories, drop oldest.
- **Cross-project transfer**: Optional — export learned patterns to a portable JSON for sharing with another D:\MCP install. (ruflo's IPFS approach is overkill.)

---

## Out of scope (defer)

- SONA / LoRA / EWC++ — the trajectory store gives the value without these.
- Active learning loop where the agent self-prompts to improve.
- User-facing pattern editor (curating which trajectories to keep).

---

## Open questions

1. **Privacy**: Trajectories include task descriptions, which may contain proprietary code/data. Default namespace per-project; never share across projects unless explicit user opt-in. Document in privacy doc.
2. **Storage growth**: One row per session. After 10k sessions, table is ~10MB plus embeddings. Add a `consolidate` worker policy to keep only top-N per project + recent.
3. **False positives in RETRIEVE**: If unrelated trajectories surface, agent may go down wrong path. Mitigate via the `score > 0.7` threshold + the explicit "if genuinely similar" guidance in the system message.
