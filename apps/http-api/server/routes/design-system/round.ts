/**
 * Routes — Design System legacy round lifecycle (retired pipeline).
 *
 *   POST /api/design-system/sessions/:id/start-round   → 410 Gone (pipeline aposentado)
 *   POST /api/design-system/sessions/:id/abort         → 410 Gone
 *   GET  /api/design-system/sessions/:id/stream        → 410 Gone
 *
 * O pipeline autônomo company (master + subordinados sobre um zip) foi
 * substituído pelo **DS Studio**: sessão single de chat sobre um
 * projeto-workspace real, com preview ao vivo e publish guiado
 * (`POST /api/design-system/studio`). Sessões legacy (kind='company')
 * continuam legíveis — versões/docs/storybook — mas nunca mais rodam
 * agente, por isso `start-round` responde 410 para TODAS as sessões.
 *
 * Big-bang: não existe compatibilidade com um orquestrador SQLite legado.
 * A migração offline normaliza execuções ativas para `interrupted`.
 */
import type { Hono } from 'hono';
import { parseSessionIdParam, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

export function mountDesignSystemRoundRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore } = deps;

  app.post('/api/design-system/sessions/:id/start-round', async (c) => {
    const id = parseSessionIdParam(c);
    const dsSession = await designSystemStore.getSession(id);
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

  app.post('/api/design-system/sessions/:id/abort', async (c) => {
    const id = parseSessionIdParam(c);
    const dsSession = await designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    return c.json({
      error:
        'Legacy Design System rounds cannot be resumed or aborted after the filesystem cutover.',
    }, 410);
  });

  app.get('/api/design-system/sessions/:id/stream', async (c) => {
    const id = parseSessionIdParam(c);
    const dsSession = await designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);
    return c.json({
      error:
        'Legacy Design System round streams are unavailable after the filesystem cutover.',
    }, 410);
  });
}
