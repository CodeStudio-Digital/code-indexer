import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatProviderResponseMeta } from '@mcp/provider-sdk';
import {
  asAgentRunId,
  assertContainedPath,
  assertPathHasNoLinksSync,
  type SessionId,
} from '@mcp/session-storage';
import { toJsonValue } from './conversation-codec.js';
import type { FsSessionStore } from './fs-session-store.js';

/**
 * Full per-turn diagnostic record. The summary counters are deliberately
 * persisted by the canonical conversation commit instead of this side metric,
 * so a crash between this write and the JSONL commit cannot create a phantom
 * completed turn in metrics/summary.json.
 */
export interface FsTurnTelemetryInput {
  session_id: SessionId;
  run_id: string;
  turn: number;
  auto_continues?: number;
  is_subagent: boolean;
  parent_run_id?: string | null;
  subagent_profile?: string | null;
  provider: string | null;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  thinking_tokens: number | null;
  history_chars: number | null;
  tool_count: number;
  tools_called: string[];
  largest_tool_result_chars: number | null;
  compaction_triggered: boolean;
  summarizer_ran: boolean;
  paginate_count: number;
  system_prompt_chars?: number | null;
  tools_def_chars?: number | null;
  eligible_tools_def_chars?: number | null;
  visible_tools_count?: number | null;
  tools_fingerprint?: string | null;
  capability_set_digest?: string | null;
  projection_digest?: string | null;
  prefix_head_hash?: string | null;
  reducer_retired_count?: number | null;
  reducer_freed_chars?: number | null;
  reducer_pending_chars?: number | null;
  estimated_cost_usd?: number | null;
  response_meta?: ChatProviderResponseMeta | null;
}

export interface FsTurnTelemetrySink {
  recordTurnTelemetry(input: FsTurnTelemetryInput): Promise<string | null>;
}

function deterministicTelemetryId(input: FsTurnTelemetryInput): string {
  const hex = createHash('sha256')
    .update('mcp-turn-telemetry\0')
    .update(String(input.session_id))
    .update('\0')
    .update(input.run_id)
    .update('\0')
    .update(String(input.turn))
    .digest('hex')
    .slice(0, 32)
    .split('');
  // RFC 4122-shaped deterministic UUID (version 5 semantics, SHA-256 input).
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16]!, 16) & 0x3]!;
  return [
    hex.slice(0, 8).join(''),
    hex.slice(8, 12).join(''),
    hex.slice(12, 16).join(''),
    hex.slice(16, 20).join(''),
    hex.slice(20, 32).join(''),
  ].join('-');
}

/**
 * Filesystem-only telemetry adapter used by the runtime.
 *
 * The deterministic UUID makes a replay of the same (session, run, turn)
 * idempotent. Existing records are immutable and are never rewritten.
 */
export class FsTurnTelemetryRepository implements FsTurnTelemetrySink {
  constructor(private readonly sessions: FsSessionStore) {}

  async recordTurnTelemetry(
    input: FsTurnTelemetryInput,
  ): Promise<string | null> {
    try {
      const runId = asAgentRunId(input.run_id);
      const parentRunId =
        input.parent_run_id == null
          ? null
          : asAgentRunId(input.parent_run_id);
      const normalizedInput: FsTurnTelemetryInput = {
        ...input,
        run_id: runId,
        parent_run_id: parentRunId,
      };
      // getSession initializes/refreshes the in-memory catalog and also
      // rejects unknown UUIDs without guessing a central fallback root.
      const session = await this.sessions.getSession(input.session_id);
      if (!session) return null;
      const entry = this.sessions.catalog.get(input.session_id);
      if (!entry) return null;

      const id = deterministicTelemetryId(normalizedInput);
      const target = join(
        entry.location.bundle_path,
        'metrics',
        'turns',
        `${id}.json`,
      );
      assertContainedPath(entry.location.bundle_path, target);
      if (existsSync(target)) {
        assertPathHasNoLinksSync(entry.location.bundle_path, target);
        return id;
      }

      await this.sessions.repository.writeEntity(
        entry.location,
        'metrics/turns',
        id,
        toJsonValue({
          schema_version: 1,
          metric_kind: 'turn_telemetry',
          id,
          ...normalizedInput,
          auto_continues: normalizedInput.auto_continues ?? 0,
          parent_run_id: parentRunId,
          subagent_profile: normalizedInput.subagent_profile ?? null,
          response_meta: normalizedInput.response_meta ?? null,
          recorded_at: new Date().toISOString(),
          // Required summary projection fields. The canonical conversation
          // metric owns the counters/tokens and is written only after commit.
          turns: 0,
          tool_calls: 0,
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          subagent_usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
        }),
      );
      return id;
    } catch (error) {
      // Diagnostics must never break a real turn. Unlike the old path this
      // only degrades to "no telemetry id"; it never writes SQLite.
      console.warn(
        `[coder] filesystem turn telemetry failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }
}
