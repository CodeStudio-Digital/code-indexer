import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  assertSupportedConversationFormat,
  isRetiredConversationFormatError,
} from '../../../retired-conversation-format.js';

const SESSION_PATH = /^\/api\/coder\/(?:session-workbench\/)?sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i;

export function mountConversationFormatGuard(app: Hono, deps: ServerDeps): void {
  app.use('/api/coder/*', async (c, next) => {
    let path: string;
    try {
      path = decodeURI(c.req.path);
    } catch {
      return c.json({ error: 'Invalid request path' }, 400);
    }
    const sessionId = SESSION_PATH.exec(path)?.[1];
    // Metadata updates and deletion remain available for retired conversations.
    if (sessionId && ['GET', 'HEAD', 'POST'].includes(c.req.method)) {
      try {
        await assertSupportedConversationFormat(deps.config.dbPath, sessionId);
      } catch (error) {
        if (isRetiredConversationFormatError(error)) {
          return c.json({ error: error.message, message: error.message, code: error.code, retryable: false }, 409);
        }
        throw error;
      }
    }
    await next();
  });
}
