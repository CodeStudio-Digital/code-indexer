import type { Database as DB } from 'better-sqlite3';

export interface FirstTurnPayloadBreakdown {
  system_prompt_chars: number | null;
  tools_array_chars: number | null;
  tools_count: number | null;
  first_turn_input_tokens: number | null;
  first_turn_output_tokens: number | null;
  estimated_chars_per_token: number;
  skills_mode: string | null;
  skills_count: number | null;
}

/**
 * Diagnostic breakdown of the first-turn payload — what the runner actually
 * shipped to the provider before any tool calls. Answers "why did turn 1
 * cost N tokens?".
 *
 *   system_prompt   — chars from persisted 'system_prompt' input row.
 *   tools_array     — chars + count from persisted 'tools_snapshot' row.
 *   first_turn      — input/output tokens of turn=1 from telemetry.
 *
 * The dashboard divides these to show a "system N% / tools M% / other R%"
 * pie of the first-turn input tokens, making payload bloat diagnose itself.
 */
export function getFirstTurnPayloadBreakdown(db: DB, sessionId: number): FirstTurnPayloadBreakdown {
  const sysRow = db
    .prepare(
      `SELECT content, meta_json FROM coder_session_inputs
       WHERE session_id = ? AND kind = 'system_prompt'
       ORDER BY id ASC LIMIT 1`,
    )
    .get(sessionId) as { content: string; meta_json: string | null } | undefined;
  const toolsRow = db
    .prepare(
      `SELECT content, meta_json FROM coder_session_inputs
       WHERE session_id = ? AND kind = 'tools_snapshot'
       ORDER BY id ASC LIMIT 1`,
    )
    .get(sessionId) as { content: string; meta_json: string | null } | undefined;
  const turn1 = db
    .prepare(
      `SELECT input_tokens, output_tokens, tools_def_chars, system_prompt_chars FROM coder_turn_telemetry
       WHERE session_id = ? AND is_subagent = 0
       ORDER BY turn ASC LIMIT 1`,
    )
    .get(sessionId) as
      | { input_tokens: number | null; output_tokens: number | null; tools_def_chars: number | null; system_prompt_chars: number | null }
      | undefined;

  let toolsCount: number | null = null;
  // Migration 072 introduced `manifest-v1`: content is a SHA-1 fingerprint
  // (40 chars) and the real byte count lives in `meta.content_chars`.
  // Legacy rows still have the full JSON in `content`.
  let toolsArrayChars: number | null = null;
  if (toolsRow?.meta_json) {
    try {
      const meta = JSON.parse(toolsRow.meta_json) as {
        tool_count?: number;
        content_chars?: number;
        schema?: string;
      };
      if (typeof meta.tool_count === 'number') toolsCount = meta.tool_count;
      if (meta.schema === 'manifest-v1' && typeof meta.content_chars === 'number') {
        toolsArrayChars = meta.content_chars;
      }
    } catch { /* malformed meta */ }
  }
  // Preferred: per-turn telemetry (Sprint 1) captures actual tools array
  // size on turn 1 even when no session-input row was written.
  if (toolsArrayChars == null && turn1?.tools_def_chars != null) {
    toolsArrayChars = turn1.tools_def_chars;
  }
  // Legacy fallback: pre-072 rows still have the full JSON in `content`.
  if (toolsArrayChars == null && toolsRow?.content) {
    // Heuristic: a 40-char hex string is almost certainly the fingerprint,
    // not legacy content. Avoid reporting "tools = 40 chars".
    const isFingerprint = toolsRow.content.length === 40 && /^[0-9a-f]{40}$/.test(toolsRow.content);
    if (!isFingerprint) toolsArrayChars = toolsRow.content.length;
  }

  let skillsMode: string | null = null;
  let skillsCount: number | null = null;
  if (sysRow?.meta_json) {
    try {
      const meta = JSON.parse(sysRow.meta_json) as { skills_mode?: string; skill_ids?: string[] };
      if (typeof meta.skills_mode === 'string') skillsMode = meta.skills_mode;
      if (Array.isArray(meta.skill_ids)) skillsCount = meta.skill_ids.length;
    } catch { /* malformed meta */ }
  }

  // System prompt size: prefer per-turn telemetry (accurate for wire bytes),
  // fall back to the legacy session-input content length.
  const systemPromptChars = turn1?.system_prompt_chars ?? sysRow?.content.length ?? null;

  return {
    system_prompt_chars: systemPromptChars,
    tools_array_chars: toolsArrayChars,
    tools_count: toolsCount,
    first_turn_input_tokens: turn1?.input_tokens ?? null,
    first_turn_output_tokens: turn1?.output_tokens ?? null,
    // Conservative ratio (matches compaction.ts heuristic so estimated
    // tokens are consistent with compaction trigger thresholds).
    estimated_chars_per_token: 4,
    skills_mode: skillsMode,
    skills_count: skillsCount,
  };
}

/**
 * Read all telemetry rows for a session in chronological (insertion) order.
 * We sort by `id` instead of `turn` because each user message spawns its own
 * run with `turn` resetting to 1; sorting by `turn` would interleave rows
 * from different rounds.
 */
export function getTurnTelemetry(db: DB, sessionId: number): Array<Record<string, unknown>> {
  return db
    .prepare(`SELECT * FROM coder_turn_telemetry WHERE session_id = ? ORDER BY id ASC`)
    .all(sessionId) as Array<Record<string, unknown>>;
}
