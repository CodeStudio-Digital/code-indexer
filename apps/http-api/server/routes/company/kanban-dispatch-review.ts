import type { Context, Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { asCompanySessionId, type CompanySessionId } from '@mcp/session-storage';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { DispatchClaims, type DispatchClaim } from '@mcp/company/services/scheduler/dispatch-claims.js';
import { CompanyWorkspaceCoordinator } from '@mcp/company/services/workspace-coordinator.js';
import { getCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { publish } from '../../../coder-bus.js';
import { withSessionLock } from '../coder/sessionLock.js';
import { notFound, parseJsonBody, parseSessionRecordIdParam } from '../_helpers.js';
import { companySurfaceConflict } from './runtime-capabilities.js';

interface Resolved { requestedId: CompanySessionId; rootId: CompanySessionId; rootFiles: CompanySessionFiles; unavailable: boolean }

export function mountCompanyKanbanDispatchReviewRoutes(app: Hono, deps: ServerDeps, resolve: (c: Context) => Promise<Resolved | null>): void {
  async function evidence(resolved: Resolved, claim: DispatchClaim) {
    const ownerFiles = new CompanySessionFiles({ companySessionId: claim.sessionId, sessionStore: deps.sessionStore });
    const ownerSession = ownerFiles.getSession();
    if ((ownerSession.parent_session_id ?? ownerSession.id) !== resolved.rootId) throw new Error('DISPATCH_OWNER_SCOPE_INVALID');
    const ownerActive = Boolean(getCompanyOrchestrator(asCompanySessionId(claim.sessionId)));
    const run = ownerFiles.getAgentRunSync(claim.agentRunId);
    const effects = (await new CompanyWorkspaceCoordinator(resolved.rootFiles.location.bundle_path).owners())
      .filter(owner => owner.agentRunId === claim.agentRunId);
    return {
      ownerActive, reviewable: !ownerActive && effects.length === 0,
      blockingReason: ownerActive ? 'Pause a sessão responsável antes de revisar o despacho.' : effects.length ? 'Revise primeiro as operações deste agente em Sessões e espaço de trabalho.' : null,
      owner: { sessionId: ownerSession.id, sessionName: ownerSession.name, sessionStatus: ownerSession.status, agentRunId: claim.agentRunId, coderSessionId: run?.coder_session_id ?? null, role: run?.role ?? null, runStatus: run?.status ?? null, statusMessage: run?.status_message ?? null },
      pendingEffects: effects.map(({ token, toolUseId, toolName, phase, startedAt }) => ({ token, toolUseId, toolName, phase, startedAt })),
    };
  }
  const path = '/api/company/sessions/:id/kanban/cards/:cardId/dispatch-review';
  app.get(path, async c => {
    const resolved = await resolve(c);
    if (!resolved) return notFound(c, 'Sessão não encontrada.');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    const card = resolved.rootFiles.getKanbanCardFullSync(cardId);
    if (!card) return notFound(c, 'Cartão não encontrado.');
    const claim = await new DispatchClaims(resolved.rootFiles.location.bundle_path).read(cardId);
    if (!claim || claim.phase === 'released') return c.json({ pending: false, claim, reviewable: false });
    try { return c.json({ pending: true, claim, task: { title: card.title, description: card.description }, ...await evidence(resolved, claim) }); }
    catch { return c.json({ error: 'Não foi possível comprovar o estado do responsável. A reserva continua protegida.', code: 'DISPATCH_OWNER_UNAVAILABLE' }, 409); }
  });
  app.post(path, async c => {
    const resolved = await resolve(c);
    if (!resolved) return notFound(c, 'Sessão não encontrada.');
    if (resolved.unavailable) return companySurfaceConflict(c, 'kanban');
    const cardId = parseSessionRecordIdParam(c, 'cardId');
    if (!resolved.rootFiles.getKanbanCardFullSync(cardId)) return notFound(c, 'Cartão não encontrado.');
    const body = await parseJsonBody<{ reviewed?: boolean; token?: string; epoch?: number }>(c);
    if (body.reviewed !== true || typeof body.token !== 'string' || !Number.isSafeInteger(body.epoch) || body.epoch! < 1) return c.json({ error: 'Confirme a revisão da execução e envie a reserva exata exibida.', code: 'DISPATCH_REVIEW_REQUIRED' }, 400);
    const claims = new DispatchClaims(resolved.rootFiles.location.bundle_path);
    const observed = await claims.read(cardId);
    if (!observed || observed.token !== body.token || observed.epoch !== body.epoch || observed.phase === 'released') return c.json({ error: 'O despacho mudou. Atualize e revise os dados atuais.', code: 'DISPATCH_REVIEW_STALE' }, 409);
    return withSessionLock(observed.sessionId, () => withSessionLock(`company-dispatch-review:${resolved.rootId}:${cardId}`, async () => {
      try {
        const current = await claims.read(cardId);
        if (!current || current.token !== body.token || current.epoch !== body.epoch || current.phase === 'released') return c.json({ error: 'O despacho mudou. Atualize e revise os dados atuais.', code: 'DISPATCH_REVIEW_STALE' }, 409);
        const state = await evidence(resolved, current);
        if (!state.reviewable) return c.json({ error: state.blockingReason, code: state.ownerActive ? 'DISPATCH_OWNER_ACTIVE' : 'DISPATCH_EFFECTS_PENDING' }, 409);
        const reviewing = await claims.beginReview(cardId, body.token!, body.epoch!);
        // Keep the card out of scheduler-ready columns before releasing its
        // claim. Review never launches another agent or asserts prior success.
        const card = resolved.rootFiles.moveKanbanCardSync(cardId, 'review');
        if (!card) throw new Error('Card disappeared during review');
        resolved.rootFiles.unassignKanbanAgentSync(cardId, reviewing.agentRunId);
        const marker = `[dispatch-review:${reviewing.token}:${reviewing.epoch}]`;
        if (!resolved.rootFiles.getKanbanCardFullSync(cardId)?.comments.some(comment => comment.content.includes(marker))) {
          resolved.rootFiles.addKanbanCommentSync(cardId, 'human', null, `${marker} Reserva liberada após revisão do operador. O resultado da execução anterior permanece inalterado. Cartão mantido em revisão; nenhum agente foi iniciado.`);
        }
        await claims.completeReview(cardId, reviewing.token, reviewing.epoch);
        const updated = resolved.rootFiles.getKanbanCardFullSync(cardId);
        const target = getCompanyOrchestrator(resolved.requestedId);
        if (target) publish(target.metaBus, 'kanban_card_updated', { cardId, patch: updated });
        return c.json({ ok: true, card: updated, original_outcome: 'unchanged', dispatched: false });
      } catch (error) {
        const stale = error instanceof Error && /DISPATCH_REVIEW_STALE|dispatch_fenced/.test(error.message);
        return c.json({ error: stale ? 'O despacho mudou. Atualize e revise os dados atuais.' : 'A revisão não terminou. A reserva continua protegida; atualize e tente novamente. Nenhum agente foi iniciado.', code: stale ? 'DISPATCH_REVIEW_STALE' : 'DISPATCH_REVIEW_INCOMPLETE' }, stale ? 409 : 503);
      }
    }));
  });
}
