import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  asAgentRunId,
  asSessionId,
  assertContainedPath,
  assertPathHasNoLinksSync,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import type { FsSessionStore } from './fs-session-store.js';

type JsonRecord = Record<string, JsonValue | undefined>;

export interface FsTurnTelemetryRow extends JsonRecord {
  id: string;
  session_id: SessionId;
  run_id: string;
  turn: number;
  is_subagent: number;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  thinking_tokens: number | null;
  history_chars: number | null;
  tool_count: number;
  tools_called_json: string | null;
  largest_tool_result_chars: number | null;
  compaction_triggered: number;
  summarizer_ran: number;
  paginate_count: number;
  estimated_cost_usd: number | null;
  system_prompt_chars: number | null;
  tools_def_chars: number | null;
  created_at: string;
}

export function telemetryRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

export function telemetryFinite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function integer(value: unknown, fallback = 0): number {
  const parsed = telemetryFinite(value);
  return parsed == null ? fallback : Math.trunc(parsed);
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function boolInt(value: unknown): number {
  return value === true || value === 1 ? 1 : 0;
}

export function telemetryTools(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function telemetryFiles(
  store: FsSessionStore,
  sessionId: SessionId | string,
): Promise<JsonRecord[]> {
  await store.getSession(sessionId);
  const entry = store.catalog.get(sessionId);
  if (!entry) return [];
  const root = join(entry.location.bundle_path, 'metrics', 'turns');
  assertContainedPath(entry.location.bundle_path, root);
  assertPathHasNoLinksSync(entry.location.bundle_path, root);
  const values: JsonRecord[] = [];
  for (const name of (await readdir(root)).filter((item) => item.endsWith('.json')).sort()) {
    const path = join(root, name);
    assertContainedPath(root, path);
    assertPathHasNoLinksSync(entry.location.bundle_path, path);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Telemetry entry is not a regular file: ${path}`);
    }
    const value = telemetryRecord(JSON.parse(await readFile(path, 'utf8')));
    if (value) values.push(value);
  }
  return values;
}

export async function listFilesystemTurnTelemetry(
  store: FsSessionStore,
  sessionId: SessionId | string,
): Promise<FsTurnTelemetryRow[]> {
  const rows: FsTurnTelemetryRow[] = [];
  for (const value of await telemetryFiles(store, sessionId)) {
    if (value.metric_kind !== 'turn_telemetry') continue;
    const id = text(value.id);
    const runId = text(value.run_id);
    const createdAt = text(value.recorded_at);
    if (!id || !runId || !createdAt) continue;
    const called = telemetryTools(value.tools_called);
    rows.push({
      ...value,
      id,
      session_id: asSessionId(sessionId),
      run_id: asAgentRunId(runId),
      turn: integer(value.turn),
      is_subagent: boolInt(value.is_subagent),
      provider: text(value.provider),
      model: text(value.model),
      input_tokens: telemetryFinite(value.input_tokens),
      output_tokens: telemetryFinite(value.output_tokens),
      cache_read_input_tokens: telemetryFinite(value.cache_read_input_tokens),
      cache_creation_input_tokens: telemetryFinite(value.cache_creation_input_tokens),
      thinking_tokens: telemetryFinite(value.thinking_tokens),
      history_chars: telemetryFinite(value.history_chars),
      tool_count: integer(value.tool_count),
      tools_called_json: called.length > 0 ? JSON.stringify(called) : null,
      largest_tool_result_chars: telemetryFinite(value.largest_tool_result_chars),
      compaction_triggered: boolInt(value.compaction_triggered),
      summarizer_ran: boolInt(value.summarizer_ran),
      paginate_count: integer(value.paginate_count),
      estimated_cost_usd: telemetryFinite(value.estimated_cost_usd),
      system_prompt_chars: telemetryFinite(value.system_prompt_chars),
      tools_def_chars: telemetryFinite(value.tools_def_chars),
      created_at: createdAt,
    });
  }
  return rows.sort((left, right) =>
    left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
}

export function sumTelemetry(
  rows: readonly FsTurnTelemetryRow[],
  field: keyof FsTurnTelemetryRow,
): number {
  return rows.reduce(
    (total, row) => total + (telemetryFinite(row[field]) ?? 0),
    0,
  );
}

function average(
  rows: readonly FsTurnTelemetryRow[],
  field: keyof FsTurnTelemetryRow,
): number | null {
  const values = rows.map((row) => telemetryFinite(row[field]))
    .filter((value): value is number => value != null);
  return values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
}

function toolBreakdown(rows: readonly FsTurnTelemetryRow[]) {
  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const name of telemetryTools(row.tools_called)) {
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].map(([name, calls]) => ({
    name, calls, total_output_chars: 0, avg_duration_ms: 0,
    truncated_count: 0, errors: 0, refused: 0, propagated_failures: 0,
    reused: 0, shadow_candidates: 0,
  })).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));
}

export async function getFilesystemFirstTurnPayload(
  store: FsSessionStore,
  sessionId: SessionId | string,
) {
  const turn = (await listFilesystemTurnTelemetry(store, sessionId))
    .find((row) => row.is_subagent === 0);
  return {
    system_prompt_chars: turn?.system_prompt_chars ?? null,
    tools_array_chars: turn?.tools_def_chars ?? null,
    tools_count: turn?.tool_count ?? null,
    first_turn_input_tokens: turn?.input_tokens ?? null,
    first_turn_output_tokens: turn?.output_tokens ?? null,
    estimated_chars_per_token: 4,
    skills_mode: null,
    skills_count: null,
  };
}

export async function getFilesystemSessionTelemetrySummary(
  store: FsSessionStore,
  sessionId: SessionId | string,
) {
  const [session, metrics, turns, messages, compactions, chapters] = await Promise.all([
    store.getSession(sessionId),
    store.getMetricsSummary(sessionId),
    listFilesystemTurnTelemetry(store, sessionId),
    store.loadAllSessionMessages(sessionId),
    store.listCompactionAttempts(sessionId),
    store.listConversationChapters(sessionId, { limit: 5_000 }),
  ]);
  if (!session) return null;
  const input = metrics.tokens.input;
  const cacheRead = metrics.tokens.cache_read;
  const messageRows = messages?.message_rows ?? [];
  const compaction = telemetryRecord(session.state.compaction);
  const last = turns.at(-1);
  const blocked = (error: string | null) =>
    error?.startsWith('prior checkpoint still pending:') === true;
  return {
    turn_count: metrics.turns,
    subagent_turn_count: turns.filter((turn) => turn.is_subagent === 1).length,
    total_input_tokens: input,
    total_output_tokens: metrics.tokens.output,
    total_cache_read_tokens: cacheRead,
    total_cache_creation_tokens: metrics.tokens.cache_creation,
    total_thinking_tokens: sumTelemetry(turns, 'thinking_tokens'),
    cache_hit_ratio: input > 0 ? cacheRead / input : null,
    total_tool_calls: metrics.tool_calls,
    peak_context_tokens: turns.reduce((peak, turn) => Math.max(
      peak,
      (turn.input_tokens ?? 0) + (turn.cache_read_input_tokens ?? 0) +
        (turn.cache_creation_input_tokens ?? 0),
    ), 0),
    compaction_turns: compactions.length,
    summarizer_turns: compactions.filter((item) => item.summarizer_ran).length,
    compaction_attempts: compactions.length,
    llm_summaries: compactions.filter((item) => item.summarizer_ran &&
      (item.status === 'summarized' || item.status === 'checkpoint_failed')).length,
    persisted_chapters: chapters.items.length,
    mechanical_fallbacks: compactions.filter(
      (item) => item.status === 'deterministic_fallback').length,
    checkpoint_failures: compactions.filter((item) =>
      item.status === 'checkpoint_failed' &&
      !item.trigger.startsWith('checkpoint_retry:') && !blocked(item.error_message)).length,
    checkpoint_retries: compactions.filter(
      (item) => item.trigger.startsWith('checkpoint_retry:')).length,
    checkpoint_blocked: compactions.filter((item) => blocked(item.error_message)).length,
    compaction_count_auto: integer(compaction?.auto_count),
    compaction_count_manual: integer(compaction?.manual_count),
    messages_all: messageRows.length,
    messages_conversation: messageRows.filter((row) => row.role !== 'tool').length,
    messages_user: messageRows.filter((row) => row.role === 'user').length,
    paginate_total: sumTelemetry(turns, 'paginate_count'),
    largest_tool_result_chars: turns.reduce<number | null>((largest, turn) =>
      turn.largest_tool_result_chars == null ? largest
        : Math.max(largest ?? 0, turn.largest_tool_result_chars), null),
    last_history_chars: last?.history_chars ?? null,
    last_turn_at: last?.created_at ?? null,
    tools_breakdown: toolBreakdown(turns),
    estimated_cost_usd: sumTelemetry(turns, 'estimated_cost_usd'),
    system_prompt_avg_chars: average(turns, 'system_prompt_chars'),
    tools_def_avg_chars: average(turns, 'tools_def_chars'),
    truncation_rate: null,
    phase_breakdown: [],
    savings: {
      cacheSavedUsd: 0, cacheReadTokens: cacheRead,
      cacheHitRatio: input > 0 ? cacheRead / input : 0,
      shapingSavedChars: 0, shapingSavedTokensEst: 0, shapingSavedUsdEst: 0,
      tierSavedTokensEstPerTurn: 0, tierSavedTokensEstTotal: 0,
      hasUnpricedTurns: turns.some((turn) => turn.estimated_cost_usd == null &&
        (turn.input_tokens != null || turn.output_tokens != null)),
    },
    structured_output: {
      calls: 0, structured_chars: 0, delivered_chars: 0,
      saved_chars: 0, reduction_ratio: null,
    },
  };
}
