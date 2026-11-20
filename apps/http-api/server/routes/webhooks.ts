import type { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../deps.js';
import { parseIdParam } from './_helpers.js';

interface CreateWebhookBody {
  project_id?: number;
  url: string;
  events: string[];
  secret?: string;
}

export function mountWebhooksRoutes(app: HttpRouter, deps: ServerDeps): void {
  const { db, webhookDispatcher } = deps;

  app.get('/api/webhooks', (c) => c.json(db.listWebhooks()));

  app.post('/api/webhooks', async (c) => {
    const body = await c.req.json<CreateWebhookBody>();
    return c.json(
      db.createWebhook({
        projectId: body.project_id,
        url: body.url,
        events: body.events,
        secret: body.secret,
      }),
      201,
    );
  });

  app.delete('/api/webhooks/:id', (c) => {
    db.deleteWebhook(parseIdParam(c));
    return c.json({ ok: true });
  });

  app.post('/api/webhooks/:id/test', async (c) => {
    const result = await webhookDispatcher.testWebhook(parseIdParam(c));
    return c.json(result);
  });
}
