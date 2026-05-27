/**
 * Routes — Design System Creator sessions.
 *
 *   POST   /api/design-system/sessions            (multipart/form-data)
 *   GET    /api/design-system/sessions
 *   GET    /api/design-system/sessions/:id
 *   PATCH  /api/design-system/sessions/:id/next-bump-hint
 *   DELETE /api/design-system/sessions/:id
 *
 * Creating a session uploads the theme zip, persists it to
 * `data/design-system-uploads/`, then creates a parent CompanySession
 * (builder-mode with the chosen stack) plus the design_system_session
 * row that links the two. The same flow as company sessions, just
 * wrapped to also accept multipart upload and seed the DS row.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { parseIdParam, parseJsonBody, notFound } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';
import { buildDesignSystemRoles } from '@mcp/design-system/template-config.js';
import { extractZipToDir } from '@mcp/design-system/extract-zip.js';
import { writeSourceInventory } from '@mcp/design-system/source-inventory.js';
import type { DsStack, DsBumpHint } from '@mcp/store/design-system-store.js';
import { McpServerStore } from '@mcp/store/mcp-server-store.js';
import { runNpm } from '@mcp/design-system/run-npm.js';
import { hasCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import { tryGetVerdaccioService } from '@mcp/services/verdaccio/verdaccio-service.js';

/**
 * Convention: the uploaded theme is unzipped into this folder of the
 * virtual project so the bind-mounted sandbox sees `/app/design_system/`
 * with the original HTML/CSS/SCSS files. Centralised so the route, the
 * master message, and tests all agree.
 */
export const DS_SOURCE_DIRNAME = 'design_system';

const VALID_STACKS: ReadonlySet<DsStack> = new Set<DsStack>(['react-ts', 'vue-ts', 'angular']);
const VALID_HINTS: ReadonlySet<DsBumpHint> = new Set<DsBumpHint>(['patch', 'minor', 'major']);
const ZIP_MAX_BYTES = 50 * 1024 * 1024;

export function mountDesignSystemSessionRoutes(app: Hono, deps: ServerDeps): void {
  const { designSystemStore, companyStore, db } = deps;

  app.post('/api/design-system/sessions', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (e) {
      return c.json({ error: `Failed to parse multipart body: ${(e as Error).message}` }, 400);
    }
    const name = stringField(form, 'name');
    const packageName = stringField(form, 'package_name');
    const stackRaw = stringField(form, 'stack');
    const masterProvider = stringField(form, 'master_provider');
    const masterModel = stringField(form, 'master_model');
    if (!name || !packageName || !stackRaw || !masterProvider || !masterModel) {
      return c.json(
        { error: 'name, package_name, stack, master_provider, master_model are required.' },
        400,
      );
    }
    if (!VALID_STACKS.has(stackRaw as DsStack)) {
      return c.json({ error: `Invalid stack '${stackRaw}'. Use react-ts, vue-ts or angular.` }, 400);
    }
    const stack = stackRaw as DsStack;

    const file = form.get('zip');
    if (!(file instanceof File)) {
      return c.json({ error: 'Multipart field `zip` is required (file upload).' }, 400);
    }
    if (file.size > ZIP_MAX_BYTES) {
      return c.json({ error: `Zip too large (max ${ZIP_MAX_BYTES} bytes).` }, 400);
    }
    if (!file.name.toLowerCase().endsWith('.zip')) {
      return c.json({ error: 'Only .zip uploads are accepted.' }, 400);
    }

    let zipPath: string;
    let zipHash: string;
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      zipHash = createHash('sha256').update(buf).digest('hex');
      const uploadsDir = join(process.cwd(), 'data', 'design-system-uploads');
      mkdirSync(uploadsDir, { recursive: true });
      zipPath = join(uploadsDir, `${zipHash.slice(0, 12)}-${randomUUID()}.zip`);
      writeFileSync(zipPath, buf);
    } catch (e) {
      return c.json({ error: `Failed to persist zip: ${(e as Error).message}` }, 500);
    }

    // Create the virtual project for the builder sandbox (mirrors the
    // company/sessions builder path).
    const projUuid = randomUUID();
    const projectRoot = join(process.cwd(), 'data', 'virtual-projects', projUuid);
    try { mkdirSync(projectRoot, { recursive: true }); } catch { /* tolerated */ }
    const virtualProject = db.createProject(
      `_design-system_${projUuid}`,
      projectRoot,
      `Virtual project for Design System session "${name}"`,
    );

    // Extract the zip into `<projectRoot>/design_system/` so the
    // sandbox sees it at `/app/design_system/` immediately. Failure
    // here is fatal — the agent has nothing to extract from otherwise.
    const designSystemDir = join(projectRoot, DS_SOURCE_DIRNAME);
    let extractStats;
    try {
      extractStats = extractZipToDir(zipPath, designSystemDir, { clean: true });
    } catch (e) {
      return c.json({ error: `Failed to extract zip into virtual project: ${(e as Error).message}` }, 500);
    }
    if (extractStats.filesWritten === 0) {
      return c.json({ error: 'Zip extracted to 0 files — empty or all entries unsafe.' }, 400);
    }
    let inventoryStats;
    try {
      const inventory = await writeSourceInventory(
        designSystemDir,
        join(projectRoot, 'source-inventory.json'),
      );
      inventoryStats = inventory.totals;
    } catch (e) {
      return c.json({ error: `Failed to write source inventory: ${(e as Error).message}` }, 500);
    }

    // Build role assignments using the shared config helper.
    const roles = buildDesignSystemRoles({ provider: masterProvider, model: masterModel });
    const roleAssignments = roles.map((r) => ({
      role: r.role,
      provider: r.provider,
      model: r.model,
      tier: r.tier,
      ...(r.systemPromptOverride ? { system_prompt_override: r.systemPromptOverride } : {}),
      ...(r.skills ? { skills: r.skills } : {}),
    }));

    const companySession = companyStore.createCompanySession({
      template_id: null,
      name: name,
      config_json: JSON.stringify({
        master_provider: masterProvider,
        master_model: masterModel,
        role_assignments: roleAssignments,
        // The SANDBOX stack is always 'node-only' for DS sessions: we
        // want a bare Node + npm container with the virtual project
        // bind-mounted, NOT a Vite scaffold polluting the workdir
        // (the uploaded theme already lives at /app/design_system/).
        // The user's chosen DS OUTPUT stack (react-ts | vue-ts | angular)
        // travels via `design_system.target_stack` and on the
        // `design_system_sessions.stack` row — that's what tells the
        // components-builder which framework to emit.
        builder: { stack: 'node-only' },
        design_system: {
          package_name: packageName,
          source_zip_path: zipPath,
          target_stack: stack,
        },
      }),
    });
    companyStore.addProjectToCompanySession(companySession.id, virtualProject.id);

    const dsSession = designSystemStore.createSession({
      company_session_id: companySession.id,
      name,
      package_name: packageName,
      stack,
      source_zip_hash: zipHash,
      source_zip_path: zipPath,
    });

    return c.json({
      design_system_session: dsSession,
      company_session_id: companySession.id,
      extracted: {
        files: extractStats.filesWritten,
        bytes: extractStats.bytesWritten,
        skipped: extractStats.skipped,
      },
      inventory: inventoryStats,
    }, 201);
  });

  app.get('/api/design-system/sessions', (c) => {
    const sessions = designSystemStore.listSessions();
    const enriched = sessions.map((s) => {
      const cs = companyStore.getCompanySession(s.company_session_id);
      const latest = designSystemStore.getLatestPublishedVersion(s.id);
      return {
        ...s,
        company_session_status: cs?.status ?? 'unknown',
        is_running: hasCompanyOrchestrator(s.company_session_id),
        latest_published_semver: latest?.semver ?? null,
        latest_published_at: latest?.published_at ?? null,
      };
    });
    return c.json({ sessions: enriched });
  });

  app.get('/api/design-system/sessions/:id', (c) => {
    const id = parseIdParam(c);
    const session = designSystemStore.getSession(id);
    if (!session) return notFound(c);
    const versions = designSystemStore.listVersions(id);
    const latestPublished = designSystemStore.getLatestPublishedVersion(id);
    const cs = companyStore.getCompanySession(session.company_session_id);
    return c.json({
      session,
      versions,
      latest_published: latestPublished,
      is_running: hasCompanyOrchestrator(session.company_session_id),
      company_session_status: cs?.status ?? 'unknown',
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

    // Resolve the virtual project's root path — the bind-mount target
    // for the sandbox. We persisted it via the linked project at create
    // time; look it up from companyStore → db.getProject.
    const linked = companyStore.listCompanySessionProjects(dsSession.company_session_id);
    const virtualProject = linked
      .map((p) => db.getProject(p.project_id))
      .find((p): p is NonNullable<typeof p> => !!p && p.name.startsWith('_design-system_'));
    if (!virtualProject || !virtualProject.root_path) {
      return c.json({ error: 'Virtual project missing — session is in an inconsistent state.' }, 500);
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
          const uploadsDir = join(process.cwd(), 'data', 'design-system-uploads');
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

    const designSystemDir = join(virtualProject.root_path, DS_SOURCE_DIRNAME);
    let stats;
    try {
      stats = extractZipToDir(zipPathToUse, designSystemDir, { clean: true });
    } catch (e) {
      return c.json({ error: `Extraction failed: ${(e as Error).message}` }, 500);
    }
    if (stats.filesWritten === 0) {
      return c.json({ error: 'Zip extracted to 0 files — empty or all entries unsafe.' }, 400);
    }
    let inventoryStats;
    try {
      const inventory = await writeSourceInventory(
        designSystemDir,
        join(virtualProject.root_path, 'source-inventory.json'),
      );
      inventoryStats = inventory.totals;
    } catch (e) {
      return c.json({ error: `Failed to write source inventory: ${(e as Error).message}` }, 500);
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

    // CASCADE delete on the company_session also drops the DS rows
    // (FK with ON DELETE CASCADE on design_system_sessions). Defensive:
    // also call the DS-level delete so isolated tests stay clean even
    // when company_session is deleted by a separate path.
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
    const installDir = join(process.cwd(), 'data', 'design-system-mcp', String(id));

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

function stringField(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === 'string' ? v.trim() : '';
}
