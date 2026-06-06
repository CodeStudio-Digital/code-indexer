/**
 * Session Drive store — the durable working memory for a single coder
 * session (migrations 125 `coder_session_memory` + 126 `coder_investigations`).
 *
 * Three concerns, all keyed off a coder session:
 *   - memory:        per-session notes the agent writes (`remember` tool),
 *                    re-injected after compaction + shown in the Drive panel.
 *   - investigations: project-scoped digests of sub-agent explorations,
 *                    auto-captured on spawn completion + keyword-recalled.
 *   - file map:      derived (no table) from `coder_tool_calls` — which files
 *                    the session read vs changed.
 *
 * Composition helpers (`getDriveAggregate`, `getDriveInjectionPayload`) pull
 * plans/tasks from the sibling modules so the panel + injector see one shape.
 */
import type { Database as DB } from 'better-sqlite3';
import * as plans from './plans.js';
import * as tasks from './tasks.js';

export interface SessionMemoryRow {
  id: number;
  session_id: number;
  kind: string;
  title: string;
  body: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

export interface InvestigationRow {
  id: number;
  project_id: number | null;
  session_id: number | null;
  topic: string;
  summary: string;
  body: string;
  source_label: string | null;
  agent_type: string | null;
  tokens: number;
  created_at: string;
}

export interface RememberInput {
  title: string;
  body: string;
  kind?: string;
  pinned?: boolean;
}

export interface RecordInvestigationInput {
  session_id: number;
  topic: string;
  summary: string;
  body?: string;
  source_label?: string | null;
  agent_type?: string | null;
  tokens?: number;
}

// ─── Memory ──────────────────────────────────────────────────────

/** Create or update (by session_id+title) a working-memory note. */
export function remember(db: DB, sessionId: number, input: RememberInput): SessionMemoryRow {
  const kind = input.kind?.trim() || 'fact';
  const pinned = input.pinned ? 1 : 0;
  db.prepare(`
    INSERT INTO coder_session_memory (session_id, kind, title, body, pinned)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id, title) DO UPDATE SET
      body = excluded.body,
      kind = excluded.kind,
      pinned = excluded.pinned,
      updated_at = datetime('now')
  `).run(sessionId, kind, input.title, input.body, pinned);
  return db.prepare('SELECT * FROM coder_session_memory WHERE session_id = ? AND title = ?')
    .get(sessionId, input.title) as SessionMemoryRow;
}

export function listMemory(db: DB, sessionId: number, opts: { kind?: string } = {}): SessionMemoryRow[] {
  if (opts.kind) {
    return db.prepare(
      `SELECT * FROM coder_session_memory WHERE session_id = ? AND kind = ?
       ORDER BY pinned DESC, updated_at DESC, id DESC`,
    ).all(sessionId, opts.kind) as SessionMemoryRow[];
  }
  return db.prepare(
    `SELECT * FROM coder_session_memory WHERE session_id = ?
     ORDER BY pinned DESC, updated_at DESC, id DESC`,
  ).all(sessionId) as SessionMemoryRow[];
}

export function setMemoryPinned(db: DB, id: number, pinned: boolean): void {
  db.prepare(`UPDATE coder_session_memory SET pinned = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(pinned ? 1 : 0, id);
}

export function deleteMemory(db: DB, id: number): boolean {
  return db.prepare('DELETE FROM coder_session_memory WHERE id = ?').run(id).changes > 0;
}

/** Pinned-first, then most-recent — the slice the injector surfaces. */
export function memoryForInjection(db: DB, sessionId: number, limit = 3): SessionMemoryRow[] {
  return db.prepare(
    `SELECT * FROM coder_session_memory WHERE session_id = ?
     ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ?`,
  ).all(sessionId, limit) as SessionMemoryRow[];
}

// ─── Investigations ──────────────────────────────────────────────

function resolveProjectId(db: DB, sessionId: number): number | null {
  const row = db.prepare('SELECT project_id FROM coder_sessions WHERE id = ?').get(sessionId) as
    | { project_id: number }
    | undefined;
  return row?.project_id ?? null;
}

// Explicit column list — keeps the `embedding` BLOB out of rows returned to
// the panel/agent (it would bloat JSON and isn't needed downstream).
const INV_COLS = 'id, project_id, session_id, topic, summary, body, source_label, agent_type, tokens, created_at';

/** Persist a sub-agent investigation digest. Resolves project scope from the session. */
export function recordInvestigation(db: DB, input: RecordInvestigationInput): InvestigationRow {
  const projectId = resolveProjectId(db, input.session_id);
  const r = db.prepare(`
    INSERT INTO coder_investigations
      (project_id, session_id, topic, summary, body, source_label, agent_type, tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    projectId, input.session_id, input.topic, input.summary,
    input.body ?? '', input.source_label ?? null, input.agent_type ?? null, input.tokens ?? 0,
  );
  return db.prepare(`SELECT ${INV_COLS} FROM coder_investigations WHERE id = ?`)
    .get(Number(r.lastInsertRowid)) as InvestigationRow;
}

/** Store the embedding for an investigation digest (best-effort, background). */
export function setInvestigationEmbedding(db: DB, id: number, embedding: Float32Array): void {
  const buf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
  db.prepare('UPDATE coder_investigations SET embedding = ? WHERE id = ?').run(buf, id);
}

/** Scope filter: project-wide when the session has a project, else session-local. */
function scopeClause(db: DB, sessionId: number): { where: string; param: number } {
  const projectId = resolveProjectId(db, sessionId);
  return projectId != null
    ? { where: 'project_id = ?', param: projectId }
    : { where: 'session_id = ?', param: sessionId };
}

/** Keyword recall over topic+summary, scoped to the session's project. */
export function recallInvestigations(db: DB, sessionId: number, query: string, limit = 8): InvestigationRow[] {
  const { where, param } = scopeClause(db, sessionId);
  const q = query.trim();
  if (!q) {
    return db.prepare(
      `SELECT ${INV_COLS} FROM coder_investigations WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(param, limit) as InvestigationRow[];
  }
  const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
  return db.prepare(
    `SELECT ${INV_COLS} FROM coder_investigations WHERE ${where}
       AND (topic LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(param, like, like, limit) as InvestigationRow[];
}

const MIN_SIMILARITY = 0.25;

function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Semantic recall: rank embedded investigations in the session's project by
 * cosine to the query vector, above a relevance floor. Brute-force is fine at
 * this scale (a few hundred rows/project). Returns [] when no embedded row
 * clears the floor — the caller then falls back to keyword recall.
 */
export function recallInvestigationsByVector(db: DB, sessionId: number, queryVec: Float32Array, limit = 8): InvestigationRow[] {
  const { where, param } = scopeClause(db, sessionId);
  const rows = db.prepare(
    `SELECT ${INV_COLS}, embedding FROM coder_investigations WHERE ${where} AND embedding IS NOT NULL`,
  ).all(param) as Array<InvestigationRow & { embedding: Buffer }>;
  const scored: Array<{ row: InvestigationRow; score: number }> = [];
  for (const r of rows) {
    const buf = r.embedding;
    // Copy into a fresh, 4-byte-aligned ArrayBuffer — a Buffer from SQLite may
    // have a non-aligned byteOffset, which would make the Float32Array view throw.
    const vec = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const score = cosine(queryVec, vec);
    if (score >= MIN_SIMILARITY) {
      const { embedding: _e, ...rest } = r;
      scored.push({ row: rest as InvestigationRow, score });
    }
  }
  scored.sort((x, y) => y.score - x.score);
  return scored.slice(0, limit).map((s) => s.row);
}

export function listInvestigations(db: DB, sessionId: number, limit = 50): InvestigationRow[] {
  const { where, param } = scopeClause(db, sessionId);
  return db.prepare(
    `SELECT ${INV_COLS} FROM coder_investigations WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(param, limit) as InvestigationRow[];
}

export function countInvestigations(db: DB, sessionId: number): number {
  const { where, param } = scopeClause(db, sessionId);
  const row = db.prepare(`SELECT COUNT(*) AS n FROM coder_investigations WHERE ${where}`).get(param) as { n: number };
  return row.n;
}

// ─── File map (derived from coder_tool_calls) ────────────────────

const READ_TOOLS = new Set(['read_file', 'get_file_skeleton', 'view_image']);
const WRITE_TOOLS = new Set(['create_file', 'edit_file', 'multi_edit', 'write_file', 'apply_patch']);

function pathsFromArgs(toolName: string, argsJson: string): string[] {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const direct = args.path ?? args.file_path;
    if (typeof direct === 'string' && direct) return [direct];
    // apply_patch: paths live in the freeform patch body.
    const raw = typeof args._raw === 'string' ? args._raw : typeof args.input === 'string' ? args.input : '';
    if (raw) {
      const out: string[] = [];
      for (const m of raw.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)) out.push(m[1].trim());
      return out;
    }
  } catch { /* ignore malformed args */ }
  return [];
}

/** Distinct files the session read vs changed, newest-first. */
export function getFileMap(db: DB, sessionId: number): { read: string[]; changed: string[] } {
  const rows = db.prepare(`
    SELECT tc.tool_name AS tool_name, tc.args_json AS args_json
      FROM coder_tool_calls tc
      JOIN coder_messages m ON m.id = tc.message_id
     WHERE m.session_id = ?
       AND tc.tool_name IN ('read_file','get_file_skeleton','view_image','create_file','edit_file','multi_edit','write_file','apply_patch')
     ORDER BY tc.id DESC
  `).all(sessionId) as Array<{ tool_name: string; args_json: string }>;
  const read = new Set<string>();
  const changed = new Set<string>();
  for (const row of rows) {
    const bucket = WRITE_TOOLS.has(row.tool_name) ? changed : READ_TOOLS.has(row.tool_name) ? read : null;
    if (!bucket) continue;
    for (const p of pathsFromArgs(row.tool_name, row.args_json)) bucket.add(p);
  }
  // A changed file is implicitly read; don't double-list it under read.
  for (const p of changed) read.delete(p);
  return { read: [...read].slice(0, 200), changed: [...changed].slice(0, 200) };
}

// ─── Composition: aggregate + injection payload ──────────────────

export interface DriveAggregate {
  memory: SessionMemoryRow[];
  investigations: InvestigationRow[];
  fileMap: { read: string[]; changed: string[] };
  plans: ReturnType<typeof plans.list>;
  tasks: ReturnType<typeof tasks.getState>;
}

export function getDriveAggregate(db: DB, sessionId: number): DriveAggregate {
  return {
    memory: listMemory(db, sessionId),
    investigations: listInvestigations(db, sessionId),
    fileMap: getFileMap(db, sessionId),
    plans: plans.list(db, sessionId),
    tasks: tasks.getState(db, sessionId),
  };
}

export interface DriveInjectionPayload {
  activePlan: { text: string; status: string } | null;
  sessionMemory: Array<{ id: string; title: string; body: string }>;
  investigationCount: number;
}

/** Compact, compaction-surviving slice fed to the dynamic injector. */
export function getDriveInjectionPayload(db: DB, sessionId: number): DriveInjectionPayload {
  const latestPlan = plans.list(db, sessionId)[0] ?? null;
  return {
    activePlan: latestPlan ? { text: latestPlan.plan_text, status: latestPlan.status } : null,
    sessionMemory: memoryForInjection(db, sessionId, 3).map((m) => ({
      id: String(m.id),
      title: m.title,
      body: m.body,
    })),
    investigationCount: countInvestigations(db, sessionId),
  };
}
