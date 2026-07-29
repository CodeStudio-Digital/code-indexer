import fs from 'node:fs';
import path from 'node:path';
import type { Hono } from 'hono';
import { resolveInsideDir } from '@mcp/sprite-studio/repo/paths.js';
import type { ServerDeps } from '../../deps.js';
import { buildSpriteExport, normalizeExportRequest } from './export-plan.js';

function statusFor(message: string): 400 | 404 | 422 {
  if (message === 'not_initialized' || message === 'not_found') return 404;
  if (message.startsWith('layer_size_mismatch')) return 422;
  return 400;
}

export function mountSpriteExportRoutes(app: Hono, deps: ServerDeps): void {
  // Read-only dry run: same resolver/packer as execute, without filesystem writes.
  app.post('/api/sprite-studio/projects/:projectId/export/plan', async (c) => {
    const request = normalizeExportRequest(await c.req.json().catch(() => null));
    if (!request) return c.json({ error: 'invalid_body' }, 400);
    try {
      return c.json(
        (await buildSpriteExport(
          deps,
          Number(c.req.param('projectId')),
          request,
        )).plan,
      );
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, statusFor(message));
    }
  });

  app.post('/api/sprite-studio/projects/:projectId/export', async (c) => {
    const request = normalizeExportRequest(await c.req.json().catch(() => null));
    if (!request) return c.json({ error: 'invalid_body' }, 400);
    try {
      const built = await buildSpriteExport(
        deps,
        Number(c.req.param('projectId')),
        request,
      );
      fs.mkdirSync(built.destination, { recursive: true });
      const written: string[] = [];
      for (const file of built.files) {
        const absolute = resolveInsideDir(built.destination, file.relPath);
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        if (file.bytes) fs.writeFileSync(absolute, file.bytes);
        else fs.writeFileSync(absolute, file.text ?? '', 'utf8');
        written.push(absolute);
      }
      return c.json({ files: written, plan: built.plan });
    } catch (error) {
      const message = (error as Error).message;
      return c.json({ error: message }, statusFor(message));
    }
  });
}
