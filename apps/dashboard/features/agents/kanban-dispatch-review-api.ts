export interface DispatchReview {
  pending: boolean;
  reviewable: boolean;
  blockingReason?: string | null;
  claim: { token: string; epoch: number; phase: string; createdAt?: number; leaseUntil: number; error?: string; review?: { completedAt?: number } } | null;
  owner?: { sessionId: string; sessionName: string; sessionStatus: string; agentRunId: string; coderSessionId: string | null; role: string | null; runStatus: string | null; statusMessage: string | null };
  pendingEffects?: Array<{ toolUseId: string; toolName: string; phase: string }>;
}
export const dispatchReviewPath = (sessionId: string, cardId: string) => `/api/company/sessions/${sessionId}/kanban/cards/${cardId}/dispatch-review`;

export async function readDispatchReview(sessionId: string, cardId: string, signal?: AbortSignal): Promise<DispatchReview> {
  const response = await fetch(dispatchReviewPath(sessionId, cardId), { signal });
  const body = await response.json().catch(() => ({})) as DispatchReview & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Não foi possível verificar o despacho (HTTP ${response.status}).`);
  return body;
}
export async function submitDispatchReview(sessionId: string, cardId: string, claim: NonNullable<DispatchReview['claim']>): Promise<void> {
  const response = await fetch(dispatchReviewPath(sessionId, cardId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reviewed: true, token: claim.token, epoch: claim.epoch }) });
  const body = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Não foi possível liberar a reserva (HTTP ${response.status}).`);
}
