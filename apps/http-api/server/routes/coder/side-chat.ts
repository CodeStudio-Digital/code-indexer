import { nativeReasoningLevels, resolveReasoningEffort } from '@mcp/provider-sdk';
import { isUuid } from '@mcp/session-storage';
import { createCoderProvider } from '@mcp/services/providers/factory.js';
import { HttpError } from '@mcp/shared/http/context.js';
import type { HttpRouter } from '@mcp/shared/http/router.js';
import { streamSSE } from '@mcp/shared/http/sse.js';
import type { SideChatModelChoice, SideChatSelection } from '@mcp/shared/side-chat.js';
import type { ServerDeps } from '../../deps.js';
import { parseJsonBody, parseSessionIdParam } from '../_helpers.js';
import { SideChatService } from './side-chat-service.js';
import type { CoderRuntime } from './state.js';

function modelRow(store: ServerDeps['providerStore'], provider: string, model: string, inherited = false) {
  const config = store.getProvider(provider);
  const row = store.listModels(provider).find(m => (m.mode ? m.model_id + '::' + m.mode : m.model_id) === model);
  if (!inherited && (!config?.enabled || !config.use_for_coder || !row?.enabled)) {
    throw new HttpError(409, { message: 'Provider/model unavailable: ' + provider + ' / ' + model });
  }
  return row;
}

export function mountSideChatRoutes(app: HttpRouter, deps: ServerDeps, runtime: CoderRuntime) {
  const service = new SideChatService(deps.sessionStore, (session, choice) => {
    const { provider, model } = choice ?? session;
    const row = modelRow(deps.providerStore, provider, model, !choice);
    if (choice?.effort && (row?.can_reason === false || !nativeReasoningLevels(row?.supported_reasoning_levels).includes(choice.effort))) {
      throw new HttpError(400, { message: 'Unsupported reasoning effort for the selected model.' });
    }
    const override = choice ? choice.effort : session.reasoning_effort_override;
    const { effort } = resolveReasoningEffort({ executionMode: choice ? undefined : session.execution_mode_override ?? undefined,
      requestedEffort: override ?? row?.default_reasoning_level,
      capability: { canReason: row?.can_reason, supportedLevels: row?.supported_reasoning_levels } });
    const inheritedUltra = !choice && (session.execution_mode_override === 'ultra' || override === 'ultra');
    const effortOverride = inheritedUltra || override ? effort : null;
    const thinking = row?.can_reason !== false && (choice && effort ? effort !== 'none' : session.thinking_enabled);
    return { provider, model, effort, effortOverride, thinking, contextWindow: row?.context_window || 16_384 };
  }, async (target, id) => {
    modelRow(deps.providerStore, target.provider, target.model);
    return createCoderProvider(target.provider, target.model, { providerId: target.provider, cloudCodeSessionId: id, textOnly: true });
  }, id => (runtime.activeRuns.get(id)?.buffer ?? []).filter(e => e.event === 'text')
    .map(e => (e.data as { text?: string })?.text ?? '').join(''));
  const path = '/api/coder/sessions/:id/side';
  app.post(path + '/open', async c => c.json(await service.open(parseSessionIdParam(c))));
  app.post(path + '/target', async c => {
    const { provider, model, effort } = await parseJsonBody<SideChatModelChoice>(c);
    if (typeof provider !== 'string' || !provider.trim() || typeof model !== 'string' || !model.trim() ||
      (effort !== null && (typeof effort !== 'string' || !effort.trim()))) {
      throw new HttpError(400, { message: 'A provider, model and nullable reasoning effort are required.' });
    }
    return c.json(await service.setTarget(parseSessionIdParam(c), { provider, model, effort }));
  });
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
  app.get(path + '/turns/:turn/stream', async c => {
    const offset = Number(c.req.raw.headers.get('Last-Event-ID') ?? c.req.query('offset') ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, { message: 'Invalid answer offset.' });
    const viewer = new AbortController();
    const updates = await service.stream(parseSessionIdParam(c), parseSessionIdParam(c, 'turn'), offset,
      AbortSignal.any([viewer.signal, c.req.raw.signal]));
    return streamSSE(c, async stream => {
      stream.onAbort(() => viewer.abort());
      for await (const update of updates) {
        if (update === null) await stream.writeSSE({ event: 'ping', data: '{}' });
        else await stream.writeSSE({ event: update.status === 'running' ? 'progress' : 'done',
          id: String(update.offset + update.answer.length), data: JSON.stringify(update) });
      }
    });
  });
  app.post(path + '/turns/:turn/cancel', async c => {
    service.cancel(parseSessionIdParam(c), parseSessionIdParam(c, 'turn'));
    return c.json({ ok: true });
  });
  app.delete(path, async c => { await service.clear(parseSessionIdParam(c)); return c.json({ ok: true }); });
}
