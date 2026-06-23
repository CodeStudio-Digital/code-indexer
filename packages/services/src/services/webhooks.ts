import { createHmac } from 'node:crypto';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { WebhookPayload } from '@mcp/shared/types.js';

export class WebhookDispatcher {
  constructor(private db: CodeIndexDB) {}

  async dispatch(
    event: string,
    project: { id: number; name: string; root_path: string },
    data: Record<string, unknown>
  ): Promise<void> {
    const webhooks = this.db.getWebhooksForEvent(project.id, event);
    if (webhooks.length === 0) return;

    const payload: WebhookPayload = {
      event: event as WebhookPayload['event'],
      timestamp: new Date().toISOString(),
      project: {
        id: project.id,
        name: project.name,
        root_path: project.root_path,
      },
      data,
    };

    const body = JSON.stringify(payload);

    await Promise.allSettled(
      webhooks.map(async (webhook) => {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (webhook.secret) {
          const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
          headers['X-Signature-256'] = `sha256=${signature}`;
        }

        let statusCode = 0;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10_000);

          const response = await fetch(webhook.url, {
            method: 'POST',
            headers,
            body,
            signal: controller.signal,
          });

          clearTimeout(timeout);
          statusCode = response.status;
        } catch {
          statusCode = 0;
        }

        this.db.updateWebhookStatus(webhook.id, statusCode);
      })
    );
  }

  async testWebhook(webhookId: number): Promise<{ status: number }> {
    const webhooks = this.db.listWebhooks();
    const webhook = webhooks.find(w => w.id === webhookId);
    if (!webhook) throw new Error(`Webhook ${webhookId} not found`);

    const payload = {
      event: 'test',
      timestamp: new Date().toISOString(),
      project: { id: 0, name: 'test', root_path: '/test' },
      data: { message: 'Test webhook delivery' },
    };

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    if (webhook.secret) {
      const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
      headers['X-Signature-256'] = `sha256=${signature}`;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);

      const response = await fetch(webhook.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      clearTimeout(timeout);
      this.db.updateWebhookStatus(webhook.id, response.status);
      return { status: response.status };
    } catch {
      this.db.updateWebhookStatus(webhook.id, 0);
      return { status: 0 };
    }
  }
}
