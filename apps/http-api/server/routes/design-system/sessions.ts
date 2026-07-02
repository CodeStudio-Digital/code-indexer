/**
 * Routes — Design System sessions (DS Studio + legacy read-only).
 *
 *   POST   /api/design-system/sessions                → 410 Gone (pipeline company aposentado)
 *   GET    /api/design-system/sessions                → list (studio + legacy, enriquecidos por kind)
 *   GET    /api/design-system/sessions/:id            → detail
 *   PATCH  /api/design-system/sessions/:id/next-bump-hint
 *   POST   /api/design-system/sessions/:id/re-extract → studio: extrai p/ <workspace>/import/
 *                                                       legacy: re-extrai design_system/ + inventário
 *   DELETE /api/design-system/sessions/:id
 *   POST   .../versions/:semver/install-mcp           → instala MCP server da versão publicada
 *
 * Criação de DS novo é exclusiva do DS Studio: `POST /api/design-system/studio`
 * (scaffold de projeto-workspace + sessão single de chat). Sessões legacy
 * (kind='company') ficam somente leitura — versões/docs/storybook.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { designSystemMcpDir, designSystemUploadsDir } from '@mcp/shared/utils/data-paths.js';
import type { Hono } from 'hono';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import { extractZipToDir } from '@mcp/design-system/extract-zip.js';
import { writeSourceInventory } from '@mcp/design-system/source-inventory.js';
import { writeThemeDigest } from '@mcp/design-system/theme-digest/theme-digest.js';
import { currentStage, parsePipelineState } from '@mcp/design-system/pipeline/stages.js';
import { roadmapProgress } from '@mcp/design-system/pipeline/roadmap.js';
import type { DesignSystemSession, DsBumpHint } from '@mcp/store/design-system-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { runNpm } from '@mcp/design-system/run-npm.js';
import { hasCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { tryGetVerdaccioService } from '@mcp/services/verdaccio/verdaccio-service.js';

/** Legacy: pasta do tema extraído dentro do virtual project (company pipeline). */
export const DS_SOURCE_DIRNAME = 'design_system';
/** Studio: material bruto de referência dentro do projeto-workspace. */
export const DS_IMPORT_DIRNAME = 'import';

const VALID_HINTS: ReadonlySet<DsBumpHint> = new Set<DsBumpHint>(['patch', 'minor', 'major']);
const ZIP_MAX_BYTES = 50 * 1024 * 1024;

interface BuilderProjectConfig {
  stack?: string;
  port?: number;
  kind?: string;
  packageName?: string;
}

function parseBuilderJson(raw: string | null | undefined): BuilderProjectConfig {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as BuilderProjectConfig;
  } catch {
    return {};
  }
}

export function mountDesignSystemSessionRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore, companyStore, db } = deps;

  /** Enrichment compartilhado entre list e detail. */
  function enrich(s: DesignSystemSession) {
    const latest = designSystemStore.getLatestPublishedVersion(s.id);
    const base = {
      ...s,
      latest_published_semver: latest?.semver ?? null,
      latest_published_at: latest?.published_at ?? null,
    };
    if (s.kind === 'studio' && s.project_id != null) {
      const project = db.getProject(s.project_id);
      const builder = parseBuilderJson(project?.builder_json);
      return {
        ...base,
        company_session_status: 'n/a',
        is_running: false,
        builder_port: builder.port ?? null,
        project: project
          ? { id: project.id, name: project.name, root_path: project.root_path }
          : null,
      };
    }
    const cs = s.company_session_id != null
      ? companyStore.getCompanySession(s.company_session_id)
      : null;
    return {
      ...base,
      company_session_status: cs?.status ?? 'unknown',
      is_running: s.company_session_id != null && hasCompanyOrchestrator(s.company_session_id),
      builder_port: null,
      project: null,
    };
  }

  app.post('/api/design-system/sessions', (c) => {
    return c.json(
      {
        error:
          'The autonomous Design System pipeline was retired. Create a DS Studio ' +
          'session instead: POST /api/design-system/studio (guided single-session ' +
          'development over a real workspace project, with live preview).',
      },
      410,
    );
  });

  app.get('/api/design-system/sessions', (c) => {
    const sessions = designSystemStore.listSessions();
    return c.json({ sessions: sessions.map(enrich) });
  });

  /** View da máquina de etapas p/ a UI: progresso do roadmap DERIVADO em leitura. */
  function pipelineView(session: DesignSystemSession) {
    const state = parsePipelineState(session.pipeline_json);
    if (!state) return null;
    const recorded: string[] = [];
    const published = designSystemStore.getLatestPublishedVersion(session.id);
    if (published) for (const comp of designSystemStore.listComponents(published.id)) recorded.push(comp.name);
    const draft = designSystemStore.getLatestVersionAny(session.id);
    if (draft && (draft.status === 'draft' || draft.status === 'building')) {
      for (const comp of designSystemStore.listComponents(draft.id)) recorded.push(comp.name);
    }
    return {
      stages: state.stages,
      current_stage: currentStage(state)?.id ?? null,
      roadmap: roadmapProgress(state.roadmap, recorded),
      theme_digest: state.theme_digest,
    };
  }

  app.get('/api/design-system/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const versions = designSystemStore.listVersions(id);
    const latestPublished = designSystemStore.getLatestPublishedVersion(id);
    const enriched = enrich(session);
    return c.json({
      session,
      versions,
      latest_published: latestPublished,
      is_running: enriched.is_running,
      company_session_status: enriched.company_session_status,
      builder_port: enriched.builder_port,
      project: enriched.project,
      pipeline: pipelineView(session),
    });
  });

  app.patch('/api/design-system/sessions/:id/next-bump-hint', async (c) => {
    const id = parseIdParam(c);
    const body = await parseJsonBody<{ hint: DsBumpHint }>(c);
    const hint = body.hint;
    if (!hint || !VALID_HINTS.has(hint)) {
      return c.json({ error: 'Body must include `hint` ∈ {patch, minor, major}.' }, 400);
    }
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const updated = designSystemStore.setNextBumpHint(id, hint);
    return c.json({ session: updated });
  });

  app.post('/api/design-system/sessions/:id/re-extract', async (c) => {
    const id = parseIdParam(c);
    const dsSession = designSystemStore.getSession(id);
    if (!dsSession) return notFound(c);

    // Resolve the extraction root per kind. Studio: the workspace project
    // itself (`<root>/import/` — raw reference material, read-only for the
    // agent). Legacy: the virtual project linked to the company session
    // (`<root>/design_system/` + the deterministic source inventory).
    let extractRoot: string;
    if (dsSession.kind === 'studio') {
      const project = dsSession.project_id != null ? db.getProject(dsSession.project_id) : null;
      if (!project?.root_path) {
        return c.json({ error: 'Workspace project missing — studio session is in an inconsistent state.' }, 500);
      }
      extractRoot = project.root_path;
    } else {
      if (dsSession.company_session_id == null) {
        return c.json({ error: 'Legacy session without company_session_id — inconsistent state.' }, 500);
      }
      const linked = companyStore.listCompanySessionProjects(dsSession.company_session_id);
      const virtualProject = linked
        .map((p) => db.getProject(p.project_id))
        .find((p): p is NonNullable<typeof p> => !!p && p.name.startsWith('_design-system_'));
      if (!virtualProject || !virtualProject.root_path) {
        return c.json({ error: 'Virtual project missing — session is in an inconsistent state.' }, 500);
      }
      extractRoot = virtualProject.root_path;
    }

    // Two paths: (a) operator uploaded a fresh zip via multipart →
    // replace the persisted zip; (b) no upload → re-extract the
    // existing zip (handy when the on-disk folder was tampered with).
    let zipPathToUse = dsSession.source_zip_path;
    let newHash: string | null = dsSession.source_zip_hash;

    const ct = c.req.header('content-type') ?? '';
    if (ct.includes('multipart/form-data')) {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch (e) {
        return c.json({ error: `Failed to parse multipart body: ${(e as Error).message}` }, 400);
      }
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
          newHash = createHash('sha256').update(buf).digest('hex');
          const uploadsDir = designSystemUploadsDir();
          mkdirSync(uploadsDir, { recursive: true });
          zipPathToUse = join(uploadsDir, `${newHash.slice(0, 12)}-${randomUUID()}.zip`);
          writeFileSync(zipPathToUse, buf);
        } catch (e) {
          return c.json({ error: `Failed to persist new zip: ${(e as Error).message}` }, 500);
        }
      }
    }

    if (!zipPathToUse) {
      return c.json({ error: 'No zip available — neither persisted nor uploaded.' }, 400);
    }

    const targetDir = join(
      extractRoot,
      dsSession.kind === 'studio' ? DS_IMPORT_DIRNAME : DS_SOURCE_DIRNAME,
    );
    let stats;
    try {
      stats = extractZipToDir(zipPathToUse, targetDir, { clean: true });
    } catch (e) {
      return c.json({ error: `Extraction failed: ${(e as Error).message}` }, 500);
    }
    if (stats.filesWritten === 0) {
      return c.json({ error: 'Zip extracted to 0 files — empty or all entries unsafe.' }, 400);
    }
    let inventoryStats = null;
    let digest: Awaited<ReturnType<typeof writeThemeDigest>> | null = null;
    let digestError: string | null = null;
    if (dsSession.kind === 'studio') {
      // Studio: regenerate the deterministic theme digest the agent reads
      // in the Análise stage (import/_analysis/). Non-fatal: extraction
      // succeeded, and the digest is regenerable via this same route.
      try {
        digest = await writeThemeDigest(targetDir);
      } catch (e) {
        digestError = (e as Error).message;
      }
    } else {
      // Legacy pipeline consumed a deterministic source inventory.
      try {
        const inventory = await writeSourceInventory(
          targetDir,
          join(extractRoot, 'source-inventory.json'),
        );
        inventoryStats = inventory.totals;
      } catch (e) {
        return c.json({ error: `Failed to write source inventory: ${(e as Error).message}` }, 500);
      }
    }

    // Persist the (possibly new) zip path + hash on the DS session.
    if (zipPathToUse !== dsSession.source_zip_path || newHash !== dsSession.source_zip_hash) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (designSystemStore as any).db
        .prepare('UPDATE design_system_sessions SET source_zip_path = ?, source_zip_hash = ? WHERE id = ?')
        .run(zipPathToUse, newHash, id);
    }

    return c.json({
      ok: true,
      extracted: {
        files: stats.filesWritten,
        bytes: stats.bytesWritten,
        skipped: stats.skipped,
      },
      inventory: inventoryStats,
      digest,
      digest_error: digestError,
      zip_replaced: zipPathToUse !== dsSession.source_zip_path,
    });
  });

  app.delete('/api/design-system/sessions/:id', async (c) => {
    const id = parseIdParam(c);
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);

    // Best-effort: unpublish from Verdaccio before removing DB rows.
    // Do not block deletion if registry is down or package was never published.
    const verdaccio = tryGetVerdaccioService();
    if (verdaccio) {
      try {
        await verdaccio.unpublishPackage(session.package_name);
      } catch (e) {
        console.warn(
          `[design-system] unpublish skipped for ${session.package_name}: ${(e as Error).message}`,
        );
      }
    }

    // Studio: removes only the DS face (session + versions via CASCADE).
    // The workspace project row and the files on disk stay — it's a real
    // host project the user may keep working on or delete separately.
    // Legacy: company_session CASCADE also drops DS rows; the DS-level
    // delete keeps isolated tests clean when company rows go separately.
    designSystemStore.deleteSession(id);
    return c.json({ ok: true });
  });

  /**
   * POST /api/design-system/sessions/:id/versions/:semver/install-mcp
   *
   * Installs the MCP server from a published DS version as an enabled
   * `mcp_server_configs` entry (id: `ds-mcp-<sessionId>`). After this
   * call, every new agent session automatically receives the
   * `ds_use_*` tools from that server.
   *
   * Safe to call multiple times — "reinstall" cleans the previous
   * extraction and updates the server config in place.
   */
  app.post('/api/design-system/sessions/:id/versions/:semver/install-mcp', async (c) => {
    const id = parseIdParam(c);
    const semver = decodeURIComponent(c.req.param('semver'));

    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);

    const version = designSystemStore.getVersionBySemver(id, semver);
    if (!version) return notFound(c);
    if (version.status !== 'published') {
      return c.json({ error: 'Only published versions can be installed as an MCP server.' }, 400);
    }
    if (!version.tarball_path) {
      return c.json({ error: 'Version has no tarball — cannot install.' }, 400);
    }
    if (!version.mcp_manifest_json) {
      return c.json({ error: 'Version has no MCP manifest — the mcp-builder may not have run for this version.' }, 400);
    }

    // Stable installation directory keyed by session id (one slot per DS
    // session — reinstalling a newer version overwrites the previous one).
    const installDir = join(designSystemMcpDir(), String(id));

    // Wipe and recreate on reinstall so stale files don't accumulate.
    try { rmSync(installDir, { recursive: true, force: true }); } catch { /* tolerate */ }
    mkdirSync(installDir, { recursive: true });

    // Use npm to extract + install the tarball into the stable directory.
    // Passing the tarball path directly avoids any registry dependency.
    const npmResult = await runNpm({
      args: ['install', '--prefix', installDir, version.tarball_path, '--no-save', '--ignore-scripts'],
      cwd: installDir,
      timeoutMs: 120_000,
    });

    if (!npmResult.ok) {
      return c.json({
        error: `npm install failed (exit ${npmResult.exitCode}): ${(npmResult.stderr || npmResult.stdout).slice(0, 500)}`,
      }, 500);
    }

    // The MCP server entry-point is always at mcp/server.js inside the package.
    const serverJsPath = join(installDir, 'node_modules', session.package_name, 'mcp', 'server.js');

    const mcpServerId = `ds-mcp-${id}`;
    const mcpStore = new McpServerStore(db.raw());
    mcpStore.upsertServer({
      id: mcpServerId,
      name: `Design System: ${session.package_name}`,
      transport: 'stdio',
      command: 'node',
      args: [serverJsPath],
      enabled: true,
      default_tier: 'navigate',
    });

    designSystemStore.setMcpServerConfigId(id, mcpServerId);

    return c.json({ ok: true, mcp_server_config_id: mcpServerId, server_js_path: serverJsPath });
  });
}
