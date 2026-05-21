/**
 * Dashboard API client for the company recommendations endpoints
 * (RolePipeline + KanbanPriorityPipeline).
 */

export interface RoleSignals {
  taskAffinity?: number;
  historySuccess?: number;
  modelCost?: number;
  reuseBonus?: number;
}

export interface RoleRecommendation {
  role: string;
  kind: 'spawn' | 'reuse';
  agentRunId?: number;
  score: number;
  signals: RoleSignals;
}

export interface RecommendRoleResponse {
  recommendations: RoleRecommendation[];
  durationMs: number;
}

export async function recommendRole(
  sessionId: number,
  task: string,
  k = 3,
): Promise<RecommendRoleResponse> {
  const r = await fetch(`/api/company/sessions/${sessionId}/recommend-role`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ task, k }),
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as RecommendRoleResponse;
}

export interface KanbanPrioritySignals {
  impact?: number;
  effort?: number;
  blocksOthers?: number;
  urgency?: number;
  roleAvailability?: number;
  blockedBy?: number;
}

export interface KanbanPriorityDiagnostic {
  id: number;
  score: number;
  signals: KanbanPrioritySignals;
}

export interface RecomputeKanbanResponse {
  ordered: Array<{ id: number; title: string; column: string; tag: string | null }>;
  diagnostics: KanbanPriorityDiagnostic[];
  durationMs: number;
}

export async function recomputeKanbanPriorities(sessionId: number): Promise<RecomputeKanbanResponse> {
  const r = await fetch(`/api/company/sessions/${sessionId}/kanban/recompute-priorities`, {
    method: 'POST',
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  return (await r.json()) as RecomputeKanbanResponse;
}
