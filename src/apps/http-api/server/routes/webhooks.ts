import type { Hono } from 'hono';
import type { ServerDeps } from '../deps.js';

interface CreateWebhookBody {
  project_id?: number;
  url: string;
  events: string[];
  secret?: string;
}

export function mountWebhooksRoutes(app: Hono, deps: ServerDeps): void {
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
    db.deleteWebhook(parseInt(c.req.param('id'), 10));
    return c.json({ ok: true });
  });

  app.post('/api/webhooks/:id/test', async (c) => {
    const result = await webhookDispatcher.testWebhook(parseInt(c.req.param('id'), 10));
    return c.json(result);
  });
}
