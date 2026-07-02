/**
 * Route — DS Studio creation.
 *
 *   POST /api/design-system/studio   (multipart/form-data → SSE)
 *
 * Campos: name, package_name, stack (react-ts|vue-ts|angular), provider,
 * model, zip OPCIONAL (material bruto → `<workspace>/import/`). Responde
 * com o mesmo stream `start/phase/log/done/error` do New Project wizard
 * (pumpScaffoldSSE garante o flush do `done` antes de fechar); o `done`
 * carrega `{ project, ds_session, coder_session_id }`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { runDsStudioScaffoldStream, type DsStudioCreateInput } from '@mcp/api-handlers';
import { designSystemUploadsDir } from '@mcp/shared/utils/data-paths.js';
import type { ServerDeps } from '../../deps.js';
import { pumpScaffoldSSE } from '../scaffold-sse-pump.js';

const ZIP_MAX_BYTES = 50 * 1024 * 1024;

function stringField(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}

export function mountDesignSystemStudioRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/design-system/studio', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (e) {
      return c.json({ error: `Failed to parse multipart body: ${(e as Error).message}` }, 400);
    }

    // Zip opcional — persistido ANTES de abrir o SSE (upload já chegou
    // inteiro no formData; falha de disco vira 500 simples, não um stream).
    let importZipPath: string | null = null;
    let importZipHash: string | null = null;
    const file = form.get('zip');
    if (file instanceof File && file.size > 0) {
      if (file.size > ZIP_MAX_BYTES) {
        return c.json({ error: `Zip too large (max ${ZIP_MAX_BYTES} bytes).` }, 400);
      }
      if (!file.name.toLowerCase().endsWith('.zip')) {
        return c.json({ error: 'Only .zip uploads are accepted.' }, 400);
      }
      try {
        const buf = Buffer.from(await file.arrayBuffer());
        importZipHash = createHash('sha256').update(buf).digest('hex');
        const uploadsDir = designSystemUploadsDir();
        mkdirSync(uploadsDir, { recursive: true });
        importZipPath = join(uploadsDir, `${importZipHash.slice(0, 12)}-${randomUUID()}.zip`);
        writeFileSync(importZipPath, buf);
      } catch (e) {
        return c.json({ error: `Failed to persist zip: ${(e as Error).message}` }, 500);
      }
    }

    const input: DsStudioCreateInput = {
      name: stringField(form, 'name'),
      package_name: stringField(form, 'package_name'),
      stack: stringField(form, 'stack') as DsStudioCreateInput['stack'],
      provider: stringField(form, 'provider'),
      model: stringField(form, 'model'),
      mode: (stringField(form, 'mode') || null) as DsStudioCreateInput['mode'],
      import_zip_path: importZipPath,
      import_zip_hash: importZipHash,
    };
    const signal = c.req.raw.signal;

    return streamSSE(c, (stream) =>
      pumpScaffoldSSE(stream, (emit) => runDsStudioScaffoldStream(deps, input, emit, signal)),
    );
  });
}
