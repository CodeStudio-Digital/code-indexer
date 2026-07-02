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

// ─── C3 — proactive kanban ─────────────────────────────────────

export interface KanbanRoleSuggestion {
  cardId: number;
  role: string;
  score: number;
}

/** Role suggestions for the top unassigned/unblocked todo+backlog cards. */
export async function suggestKanbanRoles(sessionId: number): Promise<KanbanRoleSuggestion[]> {
  const r = await fetch(`/api/company/sessions/${sessionId}/kanban/suggest-roles`, {
    method: 'POST',
  });
  if (!r.ok) {
    const err = (await r.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `HTTP ${r.status}`);
  }
  const body = (await r.json().catch(() => ({}))) as { suggestions?: KanbanRoleSuggestion[] };
  return Array.isArray(body.suggestions) ? body.suggestions : [];
}

export interface DispatchKanbanCardResult {
  ok: boolean;
  agentRunId?: number;
  role?: string;
  reason?: string;
  error?: string;
}

/** Quick-dispatch one card (explicit role skips the recommender). */
export async function dispatchKanbanCard(
  sessionId: number,
  cardId: number,
  role?: string,
): Promise<DispatchKanbanCardResult> {
  const r = await fetch(
    `/api/company/sessions/${sessionId}/kanban/cards/${cardId}/dispatch`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(role ? { role } : {}),
    },
  );
  const body = (await r.json().catch(() => ({}))) as DispatchKanbanCardResult;
  if (!r.ok && body.ok === undefined) {
    return { ok: false, error: body.error ?? `HTTP ${r.status}` };
  }
  return body;
}
