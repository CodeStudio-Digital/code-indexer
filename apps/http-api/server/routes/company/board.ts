import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { readBoardAttachment } from '@mcp/company/services/board-attachments.js';
import { classifyAttachment } from '@mcp/shared/attachments/policy.js';
import {
  parseCompanySessionIdParam,
  parseIntQuery,
  parseSessionRecordIdParam,
  notFound,
} from '../_helpers.js';

export function mountCompanyBoardRoutes(app: Hono, deps: ServerDeps): void {
  const { sessionStore } = deps;

  app.get('/api/company/sessions/:id/board/:entryId/attachments/:index', async c => {
    const id = parseCompanySessionIdParam(c);
    const entryId = parseSessionRecordIdParam(c, 'entryId');
    const index = Number(c.req.param('index'));
    if (!Number.isSafeInteger(index) || index < 0) return c.json({ error: 'Invalid attachment index' }, 400);
    await sessionStore.ensureCatalog();
    if (!sessionStore.catalog.get(id)) return notFound(c);
    const files = new CompanySessionFiles({ companySessionId: id, sessionStore });
    const attachment = files.getBoardEntrySync(entryId)?.attachments?.[index];
    if (!attachment) return notFound(c);
    let bytes: Uint8Array;
    try { bytes = await readBoardAttachment(files, attachment); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return notFound(c, 'Attachment file is missing');
      return c.json({ error: 'Attachment could not be verified' }, 422);
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Cache-Control', 'private, max-age=60');
    if (c.req.query('text') === '1') {
      if (classifyAttachment(attachment.name, attachment.mediaType) !== 'text') return c.json({ error: 'Not a text attachment' }, 415);
      const text = Buffer.from(bytes).toString('utf8');
      return c.json({ text: text.slice(0, 40_000), truncated: text.length > 40_000 });
    }
    if (c.req.query('preview') === '1' || c.req.query('thumbnail') === '1') {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(attachment.mediaType)) return c.json({ error: 'Not a supported image' }, 415);
      if (c.req.query('thumbnail') === '1') {
        const { prepareVisionImage } = await import('@mcp/services/services/docs/vision-image.js');
        const thumbnail = await prepareVisionImage(Buffer.from(bytes), { maxDimension: 240 });
        c.header('Content-Type', thumbnail.mediaType);
        return c.body(new Uint8Array(Buffer.from(thumbnail.base64, 'base64')));
      }
      c.header('Content-Type', attachment.mediaType);
      return c.body(new Uint8Array(bytes));
    }
    c.header('Content-Type', 'application/octet-stream');
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}`);
    return c.body(new Uint8Array(bytes));
  });

  app.get('/api/company/sessions/:id/board', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const sinceSeq = parseIntQuery(c, 'since_seq', 0) || undefined;
    const limit = parseIntQuery(c, 'limit', 50);
    const kind = c.req.query('kind') as
      | 'message'
      | 'decision'
      | 'question'
      | 'deliverable'
      | 'handoff'
      | 'blocker'
      | undefined;

    await sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({
      companySessionId: id,
      sessionStore,
    });
    return c.json(
      files.listBoardEntriesSync({ sinceSeq, limit, kind }),
    );
  });

  /**
   * Per-agent unread board counts. The dashboard agent panel uses this
   * to render a "X unread" badge next to each agent so the operator can
   * spot when a subordinate has board context it hasn't acknowledged.
   * Watermarks live in each independent agent-run JSON file.
   */
  app.get('/api/company/sessions/:id/board/unread', async (c) => {
    const id = parseCompanySessionIdParam(c);
    await sessionStore.ensureCatalog();
    const files = new CompanySessionFiles({
      companySessionId: id,
      sessionStore,
    });
    return c.json({ counts: files.listUnreadBoardCountsSync() });
  });
}
