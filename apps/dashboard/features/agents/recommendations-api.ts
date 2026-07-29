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
  agentRunId?: string;
  score: number;
  signals: RoleSignals;
}

export interface RecommendRoleResponse {
  recommendations: RoleRecommendation[];
  durationMs: number;
}

export async function recommendRole(
  sessionId: string,
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
  id: string;
  score: number;
  signals: KanbanPrioritySignals;
}

export interface RecomputeKanbanResponse {
  ordered: Array<{ id: string; title: string; column: string; tag: string | null }>;
  diagnostics: KanbanPriorityDiagnostic[];
  durationMs: number;
}

export async function recomputeKanbanPriorities(sessionId: string): Promise<RecomputeKanbanResponse> {
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
  cardId: string;
  role: string;
  score: number;
}

/** Role suggestions for the top unassigned/unblocked todo+backlog cards. */
export async function suggestKanbanRoles(sessionId: string): Promise<KanbanRoleSuggestion[]> {
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
  agentRunId?: string;
  role?: string;
  reason?: string;
  error?: string;
}

/** Quick-dispatch one card (explicit role skips the recommender). */
export async function dispatchKanbanCard(
  sessionId: string,
  cardId: string,
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
