/**
 * Routes — edição da spec pelo modo Blueprint (canvas de nós).
 *
 *   PUT /api/app-studio/sessions/:id/spec       { spec }
 *       — mesmo caminho da tool app_save_spec (prepareSpecSave: normalize→
 *         validate→fontes estáveis). 409 `spec_locked` com Escopo aprovado
 *         (a UI cria uma revisão versionada quando o usuário aplica mudanças);
 *         400 { issues } quando inválida.
 *   PUT /api/app-studio/sessions/:id/blueprint  { layout }
 *       — posições do canvas. SEM lock (drag salva mesmo com spec travada);
 *         clamp 64KB.
 *
 * Ambas cobertas pelo origin-guard local-only montado no index.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Hono } from 'hono';
import { prepareSpecSave } from '@mcp/app-studio/spec/save-core.js';
import { parseBlueprintLayout } from '@mcp/app-studio/blueprint/types.js';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

const LAYOUT_MAX_BYTES = 64 * 1024;

export function mountAppStudioSpecRoutes(app: Hono, deps: ServerDeps): void {
  const { appStudioStore, db } = deps;

  app.put('/api/app-studio/sessions/:id/spec', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);

    const latestScope = appStudioStore.listApprovals(id)
      .filter((approval) => approval.type === 'scope' && approval.status !== 'superseded')
      .sort((a, b) => b.bundle_revision - a.bundle_revision)[0] ?? null;
    if (latestScope?.status === 'approved') {
      return c.json(
        { code: 'spec_locked', error: 'Scope is approved — request a versioned change instead of overwriting it.' },
        409,
      );
    }

    const body = await parseJsonBody<{ spec?: unknown }>(c);
    const prepared = prepareSpecSave(body.spec, session.pipeline_json);
    if (!prepared.ok) return c.json({ issues: prepared.issues }, 400);

    appStudioStore.setSpecJson(id, prepared.specJson);
    if (prepared.workflowJson) appStudioStore.setWorkflowStateJson(id, prepared.workflowJson);

    // Espelho legível no workspace — best-effort (mesma semântica da tool).
    try {
      const project = db.getProject(session.project_id);
      if (project?.root_path) {
        const mirror = join(project.root_path, 'spec', 'app-spec.json');
        mkdirSync(dirname(mirror), { recursive: true });
        writeFileSync(mirror, prepared.mirrorJson, 'utf8');
      }
    } catch {
      /* espelho é conveniência; a spec canônica já persistiu */
    }

    return c.json({ ok: true, spec: prepared.spec });
  });

  app.put('/api/app-studio/sessions/:id/blueprint', async (c) => {
    const id = parseIdParam(c);
    const session = appStudioStore.getSession(id);
    if (!session) return notFound(c);

    const body = await parseJsonBody<{ layout?: unknown }>(c);
    const json = JSON.stringify(body.layout ?? null);
    if (json.length > LAYOUT_MAX_BYTES) {
      return c.json({ error: `Layout too large (max ${LAYOUT_MAX_BYTES} bytes).` }, 400);
    }
    if (parseBlueprintLayout(json) === null) {
      return c.json({ error: 'Body must include layout { v:1, positions: {…} }.' }, 400);
    }
    appStudioStore.setBlueprintJson(id, json);
    return c.json({ ok: true });
  });
}
