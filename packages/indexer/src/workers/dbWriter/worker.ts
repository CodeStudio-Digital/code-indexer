import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { DbWriteReq, DbWriteRes, DbWriterWorkerData, PersistAssistantTurnPayload } from '@mcp/indexer/workers/dbWriter/protocol.js';
import { classifyToolRefusal } from '@mcp/code-agent/sessions/store/tool-refusal.js';
import { classifyToolError } from '@mcp/code-agent/sessions/store/tool-error-class.js';

if (!parentPort) {
  throw new Error('dbWriter worker: must run inside worker_threads');
}

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
const { dbPath } = workerData as DbWriterWorkerData;

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const insertMsg = db.prepare(`
  INSERT INTO coder_messages
    (session_id, role, content_json, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const touchSession = db.prepare(
  "UPDATE coder_sessions SET updated_at = datetime('now') WHERE id = ?",
);
const updateMsgUsage = db.prepare(`
  UPDATE coder_messages
     SET input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_creation_tokens = ?
   WHERE id = ?
`);
const insertTool = db.prepare(`
  INSERT INTO coder_tool_calls
    (message_id, tool_use_id, tool_name, args_json, result_text, is_error, duration_ms,
     output_chars, output_chars_shaped, truncated, phase, turn_telemetry_id, refusal_kind,
     parent_tool_use_id, error_class, reduction_kind, reduction_technique,
     reduction_meta_json, output_id, run_id, parent_run_id, is_subagent,
     subagent_profile, logical_operation_id, productive)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const bumpStmt = db.prepare(`
  UPDATE coder_sessions
     SET total_input_tokens = total_input_tokens + ?,
         total_output_tokens = total_output_tokens + ?,
         total_cache_read_tokens = total_cache_read_tokens + ?,
         total_cache_creation_tokens = total_cache_creation_tokens + ?,
         last_turn_input_tokens = ?,
         updated_at = datetime('now')
   WHERE id = ?
`);

// Mirrors SessionStore.persistAssistantTurn — keep in sync if the schema changes.
const persistAssistantTurnTx = db.transaction((p: PersistAssistantTurnPayload) => {
  // Reuse the checkpointed assistant row when completing an in-flight turn;
  // otherwise insert fresh. Mirrors store/messages.ts persistAssistantTurn.
  let messageId: number;
  if (p.existing_message_id != null) {
    messageId = p.existing_message_id;
    if (p.usage) {
      updateMsgUsage.run(
        p.usage.input_tokens,
        p.usage.output_tokens,
        p.usage.cache_read_input_tokens ?? 0,
        p.usage.cache_creation_input_tokens ?? 0,
        messageId,
      );
    }
  } else {
    const r = insertMsg.run(
      p.session_id,
      p.message.role,
      JSON.stringify(p.message.content),
      p.usage?.input_tokens ?? 0,
      p.usage?.output_tokens ?? 0,
      p.usage?.cache_read_input_tokens ?? 0,
      p.usage?.cache_creation_input_tokens ?? 0,
    );
    messageId = Number(r.lastInsertRowid);
  }
  touchSession.run(p.session_id);
  const runInsertTool = (tc: PersistAssistantTurnPayload['tool_calls'][number]): void => {
    insertTool.run(
      messageId,
      tc.tool_use_id,
      tc.tool_name,
      JSON.stringify(tc.args),
      tc.result_text,
      tc.is_error ? 1 : 0,
      tc.duration_ms,
      tc.output_chars ?? (tc.result_text?.length ?? 0),
      tc.output_chars_shaped ?? null,
      tc.truncated ? 1 : 0,
      tc.phase ?? null,
      tc.turn_telemetry_id ?? null,
      tc.refusal_kind ?? classifyToolRefusal(tc.result_text, tc.is_error),
      tc.parent_tool_use_id ?? null,
      classifyToolError(tc.result_text, tc.is_error),
      tc.reduction_kind ?? null,
      tc.reduction_technique ?? null,
      tc.reduction_meta_json ?? null,
      tc.output_id ?? null,
      tc.run_id ?? null,
      tc.parent_run_id ?? null,
      tc.is_subagent ? 1 : 0,
      tc.subagent_profile ?? null,
      tc.logical_operation_id ?? null,
      tc.productive == null ? null : tc.productive ? 1 : 0,
    );
  };
  for (const tc of p.tool_calls) runInsertTool(tc);
  // Nested (code_exec) rows: audit-only — same table, parent linkage set,
  // EXCLUDED from the paired tool message synthesis below.
  for (const tc of p.nested_tool_calls ?? []) runInsertTool(tc);
  // Paired tool-role message (mirrors store/messages.ts persistAssistantTurn):
  // the dashboard derives tool status from the presence of a matching
  // tool_result block, so this must land atomically with the assistant turn.
  if (p.tool_calls.length > 0) {
    const toolResultBlocks = p.tool_calls.map((tc) => ({
      type: 'tool_result' as const,
      tool_use_id: tc.tool_use_id,
      content: tc.result_text,
      is_error: tc.is_error,
      ...(tc.truncated
        ? { truncated: true, originalSize: tc.output_chars ?? tc.result_text.length }
        : {}),
    }));
    insertMsg.run(p.session_id, 'tool', JSON.stringify(toolResultBlocks), 0, 0, 0, 0);
  }
  if (p.usage) {
    bumpStmt.run(
      p.usage.input_tokens,
      p.usage.output_tokens,
      p.usage.cache_read_input_tokens ?? 0,
      p.usage.cache_creation_input_tokens ?? 0,
      p.usage.input_tokens,
      p.session_id,
    );
  }
  if (p.subagent_usage) {
    bumpStmt.run(
      p.subagent_usage.input_tokens,
      p.subagent_usage.output_tokens,
      p.subagent_usage.cache_read_input_tokens ?? 0,
      p.subagent_usage.cache_creation_input_tokens ?? 0,
      p.subagent_usage.input_tokens,
      p.session_id,
    );
  }
  return messageId;
});

interface InboundEnvelope {
  reqId: number;
  body: DbWriteReq;
}

parentPort.on('message', (msg: InboundEnvelope) => {
  try {
    const req = msg.body;
    let result: DbWriteRes;
    switch (req.kind) {
      case 'persistAssistantTurn': {
        const messageId = persistAssistantTurnTx(req.payload) as number;
        result = { kind: 'persistAssistantTurn', messageId };
        break;
      }
      default: {
        const k = (req as { kind: string }).kind;
        throw new Error(`unknown dbWriter req kind: ${k}`);
      }
    }
    parentPort!.postMessage({ reqId: msg.reqId, ok: true, result });
  } catch (err) {
    const e = err as Error & { code?: string };
    parentPort!.postMessage({
      reqId: msg.reqId,
      ok: false,
      error: { message: e.message, code: e.code },
    });
  }
});

parentPort.postMessage({ kind: 'ready' });

const cleanup = (): void => {
  try { db.close(); } catch { /* ignore */ }
};
process.on('beforeExit', cleanup);
process.on('exit', cleanup);
