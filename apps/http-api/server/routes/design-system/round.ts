/**
 * Routes — Design System legacy round lifecycle (retired pipeline).
 *
 *   POST /api/design-system/sessions/:id/start-round   → 410 Gone (pipeline aposentado)
 *   POST /api/design-system/sessions/:id/abort         → kill leftover legacy orchestrator
 *   GET  /api/design-system/sessions/:id/stream        → SSE attach (legacy only)
 *
 * O pipeline autônomo company (master + subordinados sobre um zip) foi
 * substituído pelo **DS Studio**: sessão single de chat sobre um
 * projeto-workspace real, com preview ao vivo e publish guiado
 * (`POST /api/design-system/studio`). Sessões legacy (kind='company')
 * continuam legíveis — versões/docs/storybook — mas nunca mais rodam
 * agente, por isso `start-round` responde 410 para TODAS as sessões.
 *
 * `abort`/`stream` permanecem apenas para observar/encerrar um
 * orquestrador legacy que porventura ainda esteja vivo no processo.
 */
import type { Hono } from 'hono';
import {
  deleteCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import { pumpBusToSSE, parseLastEventId } from '../../../sse/pumpBusToSSE.js';
import { parseIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

export function mountDesignSystemRoundRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore, companyStore } = deps;

  app.post('/api/design-system/sessions/:id/start-round', (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    return c.json(
      {
        error:
          'The autonomous Design System pipeline was retired. Create a DS Studio ' +
          'session instead (POST /api/design-system/studio) — guided single-session ' +
          'development with live preview and publish.',
      },
      410,
    );
  });

  app.post('/api/design-system/sessions/:id/abort', (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    const companySessionId = dsSession.company_session_id;
    if (companySessionId == null) {
      // Studio sessions have no company orchestrator to abort.
      return c.json({ ok: true, was_running: false });
    }
    const orch = getCompanyOrchestrator(companySessionId);
    if (!orch) return c.json({ ok: true, was_running: false });
    orch.abortAll();
    deleteCompanyOrchestrator(companySessionId);
    companyStore.updateCompanySessionStatus(companySessionId, 'paused');
    return c.json({ ok: true, was_running: true });
  });

  app.get('/api/design-system/sessions/:id/stream', (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    const companySessionId = dsSession.company_session_id;
    const orch = companySessionId == null ? null : getCompanyOrchestrator(companySessionId);
    if (!orch) return c.json({ error: 'No legacy round running.' }, 404);
    return pumpBusToSSE(c, orch.metaBus, { since: parseLastEventId(c) });
  });
}
