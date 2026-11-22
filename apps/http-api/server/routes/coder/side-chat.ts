import { resolveReasoningEffort } from '@mcp/provider-sdk';
import { isUuid } from '@mcp/session-storage';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { getStore } from '@mcp/services/providers/shared/store.js';
import { HttpError } from '@mcp/shared/http/context.js';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { SideChatSelection, SideChatTarget } from '@mcp/shared/side-chat.js';
import type { ServerDeps } from '../../deps.js';
import { parseJsonBody, parseSessionIdParam } from '../_helpers.js';
import { SideChatService } from './side-chat-service.js';
import type { CoderRuntime } from './state.js';

function modelRow(provider: string, model: string) {
  const store = getStore();
  const row = store?.listModels(provider).find(m => (m.mode ? m.model_id + '::' + m.mode : m.model_id) === model);
  if (!store?.getProvider(provider)?.enabled || !row?.enabled) {
    throw new HttpError(409, { message: 'Provider/model unavailable: ' + provider + ' / ' + model });
  }
  return row;
}

export function mountSideChatRoutes(app: HttpRouter, deps: ServerDeps, runtime: CoderRuntime) {
  const service = new SideChatService(deps.sessionStore, session => {
    const row = modelRow(session.provider, session.model);
    const { effort } = resolveReasoningEffort({ executionMode: session.execution_mode_override ?? undefined,
      requestedEffort: session.reasoning_effort_override ?? row.default_reasoning_level,
      capability: { canReason: row.can_reason, supportedLevels: row.supported_reasoning_levels } });
    return { provider: session.provider, model: session.model, effort, thinking: session.thinking_enabled,
      contextWindow: row.context_window || 16_384 } satisfies SideChatTarget;
  }, async (target, id) => {
    modelRow(target.provider, target.model);
    return createCoderProvider(target.provider, target.model, { providerId: target.provider, cloudCodeSessionId: id, textOnly: true });
  }, id => (runtime.activeRuns.get(id)?.buffer ?? []).filter(e => e.event === 'text')
    .map(e => (e.data as { text?: string })?.text ?? '').join(''));
  const path = '/api/coder/sessions/:id/side';
  app.post(path + '/open', async c => c.json(await service.open(parseSessionIdParam(c))));
  app.post(path + '/context', async c => c.json(await service.update(parseSessionIdParam(c), 'refresh')));
  app.post(path + '/selection', async c => {
    const { selection } = await parseJsonBody<{ selection: SideChatSelection | null }>(c);
    if (selection !== null && (!selection || typeof selection.text !== 'string' || !selection.text.trim()
      || selection.text.length > 4000 || (selection.seq !== null && !(Number.isSafeInteger(selection.seq) && selection.seq > 0)))) {
      throw new HttpError(400, { message: 'Invalid transcript selection (maximum 4000 characters).' });
    }
    return c.json(await service.update(parseSessionIdParam(c), 'select', selection));
  });
  app.post(path + '/turns', async c => {
    const { id, question } = await parseJsonBody<{ id: string; question: string }>(c);
    if (!isUuid(id) || typeof question !== 'string' || !question.trim() || question.length > 12_000) {
      throw new HttpError(400, { message: 'A turn ID and a question of up to 12000 characters are required.' });
    }
    return c.json(await service.submit(parseSessionIdParam(c), id, question.trim()));
  });
  app.get(path + '/turns/:turn', async c => {
    const offset = Number(c.req.query('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, { message: 'Invalid answer offset.' });
    return c.json(await service.progress(parseSessionIdParam(c), parseSessionIdParam(c, 'turn'), offset, c.req.raw.signal));
  });
  app.post(path + '/turns/:turn/cancel', async c => {
    service.cancel(parseSessionIdParam(c), parseSessionIdParam(c, 'turn'));
    return c.json({ ok: true });
  });
  app.delete(path, async c => { await service.clear(parseSessionIdParam(c)); return c.json({ ok: true }); });
}
