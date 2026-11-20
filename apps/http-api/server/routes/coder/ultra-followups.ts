import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { TaskProposal, ScheduledTrigger, ScheduledOccurrence } from '@mcp/agent-runtime-contracts';
import { CollaborationFollowups } from '@mcp/session-storage/collaboration/followups.js';
import type { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import { ChatScheduler, type ScheduleInput } from '@mcp/code-agent/runtime/chat-scheduler.js';
import { parseJsonBody, parseSessionIdParam } from '../_helpers.js';
import { CollaborationBudget } from '@mcp/session-storage/collaboration/budget.js';
import { CollaborationRevisions } from '@mcp/session-storage/collaboration/revisions.js';
import { withSessionLock } from './sessionLock.js';
import { asSessionId } from '@mcp/agent-runtime-contracts';
import type { ChatNetworkPolicySnapshot } from '@mcp/agent-runtime-contracts/chat-network.js';
interface UltraSettings { maxParallel?: number; maxStarts?: number }

export function mountUltraFollowupRoutes(app: HttpRouter, network: SessionNetwork, scheduler: ChatScheduler, ready: Promise<void>) {
  const records = new CollaborationFollowups(network.mailbox.files);
  const base = '/api/coder/sessions/:id/collaboration';
  app.get(`${base}/policy`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const config = await network.config(id), root = await network.config(config.rootId);
    const settings = await new CollaborationRevisions(network.mailbox.files).read<UltraSettings>('policies', `${id}:settings`);
    const ledger = new CollaborationBudget(network.mailbox.files, `${root.rootId}:${root.budgetId}:ultra`, { maxParallel: 3, maxStarts: 24 });
    const budget = await ledger.state();
    const rows = Object.values(budget.reservations);
    return c.json({ isBudgetRoot: config.rootId === id, policy: await network.mailbox.files.get<ChatNetworkPolicySnapshot['policy']>('policies', id), settings: { maxParallel: settings?.value.maxParallel, maxStarts: settings?.value.maxStarts }, revision: settings?.revision ?? 0,
      budget: { rootId: budget.rootId, limits: budget.limits, starts: rows.filter(row => (row.kind ?? 'agent') === 'agent').length,
        active: rows.filter(row => (row.kind ?? 'agent') === 'agent' && row.state !== 'settled').length,
        tokens: rows.reduce((total, row) => total + row.tokens, 0),
        costUsd: rows.some(row => (row.kind === 'model' || row.kind === 'suggestion') && row.cost === null) ? null : rows.reduce((sum, row) => sum + (row.cost ?? 0), 0),
        uncertain: rows.filter(row => row.state === 'unknown').length } } satisfies ChatNetworkPolicySnapshot);
  });
  app.patch(`${base}/policy`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const body = await parseJsonBody<UltraSettings & { expectedRevision: number }>(c);
    try {
      const config = await network.config(id);
      if (!Number.isInteger(body.expectedRevision)
        || (body.maxParallel !== undefined && (!Number.isInteger(body.maxParallel) || body.maxParallel < 1 || body.maxParallel > 3))
        || (body.maxStarts !== undefined && (!Number.isInteger(body.maxStarts) || body.maxStarts < 1 || body.maxStarts > 100))) throw new Error('invalid_policy');
      if (body.maxStarts !== undefined && config.rootId !== id) throw new Error('scope_denied: change the budget in the root chat');
      const result = await new CollaborationRevisions(network.mailbox.files).change<UltraSettings>('policies', `${id}:settings`, {},
        current => ({ maxParallel: current.maxParallel, maxStarts: current.maxStarts, ...(body.maxParallel !== undefined ? { maxParallel: body.maxParallel } : {}),
          ...(body.maxStarts !== undefined ? { maxStarts: body.maxStarts } : {}) }), body.expectedRevision);
      if (config.rootId === id) await new CollaborationBudget(network.mailbox.files, `${id}:${config.budgetId}:ultra`,
        { maxParallel: result.value.maxParallel ?? 3, maxStarts: result.value.maxStarts ?? 24 }).configure({
          ...(result.value.maxParallel !== undefined ? { maxParallel: result.value.maxParallel } : {}),
          ...(result.value.maxStarts !== undefined ? { maxStarts: result.value.maxStarts } : {}),
        });
      return c.json({ ...result, applies: 'next_run' });
    } catch (error) { return c.json({ error: String(error) }, /revision_conflict/.test(String(error)) ? 409 : 400); }
  });
  app.get(`${base}/prompt-suggestion`, async c => {
    await ready; const id = parseSessionIdParam(c); const session = await network.session(id);
    const last = (await network.mailbox.completions(id)).at(-1);
    if (session.status === 'running' || !last || last.reason !== 'completed') return c.json({ suggestion: null });
    const proposal = (await records.list<TaskProposal>('proposals', id)).find(row => row.state === 'pending'
      && row.expiresAt > Date.now() && row.sourceRevision === last.runId);
    const dismissed = proposal && await network.mailbox.files.get('checkpoints', `suggestion-dismissed:${id}:${proposal.id}`);
    // Cheap optional suggestion from an existing proposal; no extra provider
    // invocation, tool access or automatic task creation.
    return c.json({ suggestion: proposal && !dismissed ? { schemaVersion: 1, id: proposal.id, sessionId: id,
      sourceRevision: last.runId, text: proposal.prompt.slice(0, 500), title: proposal.title,
      createdAt: proposal.createdAt, expiresAt: proposal.expiresAt, costUsd: 0 } : null });
  });
  app.post(`${base}/prompt-suggestion/:suggestionId/dismiss`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const proposal = await records.get<TaskProposal>('proposals', c.req.param('suggestionId'));
    if (!proposal || proposal.sessionId !== id) return c.json({ error: 'scope_denied' }, 400);
    await network.mailbox.files.insert('checkpoints', `suggestion-dismissed:${id}:${proposal.id}`, { at: Date.now() });
    return c.json({ dismissed: true });
  });
  app.get(`${base}/followups`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const proposals = (await records.list<TaskProposal>('proposals', id)).map(row =>
      row.state === 'pending' && row.expiresAt <= Date.now() ? { ...row, state: 'expired' as const } : row);
    return c.json({ proposals, schedules: await records.list<ScheduledTrigger>('schedules', id),
      occurrences: (await records.list<ScheduledOccurrence>('occurrences', id)).sort((a, b) => b.dueAt - a.dueAt).slice(0, 50) });
  });
  app.post(`${base}/proposals`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const body = await parseJsonBody<{ title: string; prompt: string; rationale: string; sourceRevision: string; context: TaskProposal['context']; requestId: string }>(c);
    try {
      if (typeof body.title !== 'string' || typeof body.prompt !== 'string' || typeof body.rationale !== 'string'
        || typeof body.sourceRevision !== 'string' || !body.context || !body.requestId) throw new Error('invalid_proposal');
      return c.json(await records.propose({ title: body.title, prompt: body.prompt, rationale: body.rationale,
        sourceRevision: body.sourceRevision, context: body.context, sessionId: id }, body.requestId));
    }
    catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.post(`${base}/proposals/:proposalId/accept`, async c => {
    await ready; const id = parseSessionIdParam(c); const session = await network.session(id);
    const body = await parseJsonBody<{ revision: number; requestId: string; mode: 'here' | 'new' }>(c);
    try {
      if (!Number.isInteger(body.revision) || !body.mode || !body.requestId) throw new Error('revision_and_claim_required');
      const pending = await records.get<TaskProposal>('proposals', c.req.param('proposalId'));
      if (pending?.state === 'pending' && session.status === 'running') throw new Error('proposal_stale: wait for the current turn before accepting an earlier proposal');
      const last = (await network.mailbox.completions(id)).at(-1);
      if (pending?.state === 'pending' && last && pending.sourceRevision !== last.runId) throw new Error('proposal_stale: source conversation changed; request a refreshed proposal');
      let row = await records.claim(c.req.param('proposalId'), id, body.mode, body.requestId, body.revision!);
      if (row.targetSessionId) return c.json({ proposal: row, seed: row.prompt, sessionId: row.targetSessionId });
      let targetSessionId = id;
      if (body.mode === 'new') {
        // Same proposal always yields the same child ID, even if the host dies
        // between session creation and recording the link.
        const child = await network.create(id, { title: row.title, role: row.prompt, start: false }, `proposal:${row.id}`, true, row.context === 'fork');
        targetSessionId = child.id;
      }
      row = await records.change('proposals', row, current => ({ ...current, state: 'accepted', targetSessionId }), row.revision);
      return c.json({ proposal: row, seed: row.prompt, sessionId: targetSessionId });
    } catch (error) { return c.json({ error: String(error) }, /revision_conflict/.test(String(error)) ? 409 : 400); }
  });
  app.post(`${base}/proposals/:proposalId/dismiss`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const body = await parseJsonBody<{ revision: number }>(c);
    try {
      const row = await records.get<TaskProposal>('proposals', c.req.param('proposalId'));
      if (!Number.isInteger(body.revision)) throw new Error('revision_required');
      if (!row || row.sessionId !== id) throw new Error('scope_denied');
      return c.json(await records.change('proposals', row, current => {
        if (current.state !== 'pending') throw new Error('proposal_unavailable');
        return { ...current, state: 'dismissed' };
      }, body.revision));
    } catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.post(`${base}/schedules`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const body = await parseJsonBody<ScheduleInput & { requestId: string }>(c);
    try { return c.json(await scheduler.create(id, body as ScheduleInput, body.requestId ?? '', true)); }
    catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.post(`${base}/schedules/:scheduleId/control`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const body = await parseJsonBody<{ revision: number; action: 'pause' | 'resume' | 'cancel' }>(c);
    try {
      if (!Number.isInteger(body.revision) || !body.action || !['pause', 'resume', 'cancel'].includes(body.action)) throw new Error('invalid_schedule_control');
      return c.json(await withSessionLock(asSessionId(id), () => scheduler.control(id, c.req.param('scheduleId'), body.action!, body.revision!)));
    } catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.get(`${base}/events`, async c => {
    await ready; const id = parseSessionIdParam(c); await network.session(id);
    const events = await network.mailbox.completions(id), after = c.req.query('after');
    const index = after ? events.findIndex(row => row.runId === after) : -1;
    if (after && index === -1) return c.json({ error: 'cursor_expired' }, 409);
    const page = events.slice(index + 1, index + 101);
    return c.json({ items: page, cursor: page.at(-1)?.runId ?? after ?? null });
  });
}
