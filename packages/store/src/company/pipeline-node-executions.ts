import type { Database as DB } from 'better-sqlite3';
import type {
  PipelineNodeExecution,
  PipelineNodeStatus,
} from '@mcp/company/types.js';

interface NodeExecutionRow {
  id: number;
  execution_id: number;
  node_id: string;
  node_label: string;
  role: string;
  status: string;
  agent_run_id: number | null;
  kanban_card_id: number | null;
  coder_session_id: number | null;
  input_text: string;
  output_text: string | null;
  outcome_branch: string | null;
  attempt: number;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  usage_json: string | null;
  created_at: string;
}

function mapNodeExecutionRow(row: NodeExecutionRow): PipelineNodeExecution {
  return {
    id: row.id,
    execution_id: row.execution_id,
    node_id: row.node_id,
    node_label: row.node_label,
    role: row.role,
    status: row.status as PipelineNodeStatus,
    agent_run_id: row.agent_run_id,
    kanban_card_id: row.kanban_card_id,
    coder_session_id: row.coder_session_id,
    input_text: row.input_text,
    output_text: row.output_text,
    outcome_branch: row.outcome_branch,
    attempt: row.attempt,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error_message: row.error_message,
    usage_json: row.usage_json,
  };
}

export interface CreateNodeExecutionInput {
  executionId: number;
  nodeId: string;
  nodeLabel: string;
  role: string;
  inputText: string;
  attempt?: number;
  agentRunId?: number | null;
  kanbanCardId?: number | null;
  coderSessionId?: number | null;
}

export function create(db: DB, input: CreateNodeExecutionInput): PipelineNodeExecution {
  const stmt = db.prepare(`
    INSERT INTO pipeline_node_executions
      (execution_id, node_id, node_label, role, status, agent_run_id, kanban_card_id,
       coder_session_id, input_text, attempt, started_at)
    VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, datetime('now'))
  `);
  const r = stmt.run(
    input.executionId,
    input.nodeId,
    input.nodeLabel,
    input.role,
    input.agentRunId ?? null,
    input.kanbanCardId ?? null,
    input.coderSessionId ?? null,
    input.inputText,
    input.attempt ?? 1,
  );
  return get(db, Number(r.lastInsertRowid))!;
}

export function get(db: DB, id: number): PipelineNodeExecution | null {
  const row = db.prepare('SELECT * FROM pipeline_node_executions WHERE id = ?').get(id) as NodeExecutionRow | undefined;
  return row ? mapNodeExecutionRow(row) : null;
}

export function list(db: DB, executionId: number): PipelineNodeExecution[] {
  const rows = db
    .prepare('SELECT * FROM pipeline_node_executions WHERE execution_id = ? ORDER BY created_at ASC, id ASC')
    .all(executionId) as NodeExecutionRow[];
  return rows.map(mapNodeExecutionRow);
}

export function update(
  db: DB,
  id: number,
  patch: {
    status?: PipelineNodeStatus;
    agentRunId?: number | null;
    kanbanCardId?: number | null;
    coderSessionId?: number | null;
    outputText?: string | null;
    outcomeBranch?: string | null;
    finishedAt?: string | null;
    errorMessage?: string | null;
    usageJson?: string | null;
  },
): PipelineNodeExecution | null {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.status !== undefined) { sets.push('status = ?'); params.push(patch.status); }
  if (patch.agentRunId !== undefined) { sets.push('agent_run_id = ?'); params.push(patch.agentRunId); }
  if (patch.kanbanCardId !== undefined) { sets.push('kanban_card_id = ?'); params.push(patch.kanbanCardId); }
  if (patch.coderSessionId !== undefined) { sets.push('coder_session_id = ?'); params.push(patch.coderSessionId); }
  if (patch.outputText !== undefined) { sets.push('output_text = ?'); params.push(patch.outputText); }
  if (patch.outcomeBranch !== undefined) { sets.push('outcome_branch = ?'); params.push(patch.outcomeBranch); }
  if (patch.finishedAt !== undefined) { sets.push('finished_at = ?'); params.push(patch.finishedAt); }
  if (patch.errorMessage !== undefined) { sets.push('error_message = ?'); params.push(patch.errorMessage); }
  if (patch.usageJson !== undefined) { sets.push('usage_json = ?'); params.push(patch.usageJson); }
  if (sets.length === 0) return get(db, id);
  params.push(id);
  db.prepare(`UPDATE pipeline_node_executions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return get(db, id);
}
