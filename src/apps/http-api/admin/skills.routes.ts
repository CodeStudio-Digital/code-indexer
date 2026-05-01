/**
 * /skills CRUD + import/export + usage stats.
 *
 * Thin wrappers around SkillStore. Follows the same pattern as mcp-servers.routes.ts.
 */
import { Hono } from 'hono';
import { SkillStore, type UpsertSkillInput, type SkillDefinition } from '../../../store/skill-store.js';
import { loadConfig } from '../../../utils/config.js';
import {
  installFromGithub,
  uninstallNamespace,
  listInstalledNamespaces,
} from '../../../core/coder/skills/agent-skills-installer.js';
import { installFromLocalFolder } from '../../../core/coder/skills/local-skills-installer.js';
import { installFromUrl } from '../../../core/coder/skills/url-skills-installer.js';

function getStore() {
  const config = loadConfig();
  return new SkillStore(config.dbPath);
}

export function skillsRouter(): Hono {
  const app = new Hono();

  // ─── List all skills ─────────────────────────────────────────
  app.get('/skills', (c) => {
    const store = getStore();
    try {
      const scope = c.req.query('scope');
      const enabled = c.req.query('enabled');
      const source = c.req.query('source');
      const tag = c.req.query('tag');
      const skills = store.listSkills({
        scope: scope || undefined,
        enabled: enabled !== undefined ? enabled === 'true' : undefined,
        source: source as UpsertSkillInput['source'] | undefined,
        tag: tag || undefined,
      });
      return c.json({ skills });
    } finally {
      store.close();
    }
  });

  // ─── Install from GitHub (Agent Skills standard) ─────────────
  // NOTE: these literal paths must be registered BEFORE /skills/:id
  // to avoid being shadowed by the param route.
  app.post('/skills/install-github', async (c) => {
    const body = await c.req.json<{
      repo: string;
      namespace?: string;
      ref?: string;
      overwrite?: boolean;
    }>();
    if (!body.repo || !/^[\w.-]+\/[\w.-]+$/.test(body.repo)) {
      return c.json({ error: 'repo must be in "owner/name" format' }, 400);
    }
    try {
      const result = await installFromGithub({
        repo: body.repo,
        namespace: body.namespace,
        ref: body.ref,
        overwrite: body.overwrite ?? false,
      });
      return c.json(result, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ─── Install from URL (mcp.directory zip) ────────────────────
  app.post('/skills/install-url', async (c) => {
    const body = await c.req.json<{
      url: string;
      namespace?: string;
      overwrite?: boolean;
    }>();
    if (!body.url || typeof body.url !== 'string') {
      return c.json({ error: 'url is required' }, 400);
    }
    try {
      const result = await installFromUrl({
        url: body.url.trim(),
        namespace: body.namespace,
        overwrite: body.overwrite ?? false,
      });
      return c.json(result, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ─── Install from local folder ───────────────────────────────
  app.post('/skills/install-local', async (c) => {
    const body = await c.req.json<{
      folderPath: string;
      namespace?: string;
      overwrite?: boolean;
    }>();
    if (!body.folderPath || typeof body.folderPath !== 'string') {
      return c.json({ error: 'folderPath is required' }, 400);
    }
    if (body.folderPath.includes('..')) {
      return c.json({ error: 'folderPath must not contain ".." segments' }, 400);
    }
    try {
      const result = await installFromLocalFolder({
        folderPath: body.folderPath,
        namespace: body.namespace,
        overwrite: body.overwrite ?? false,
      });
      return c.json(result, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.get('/skills/namespaces', (c) =>
    c.json({ namespaces: listInstalledNamespaces() }),
  );

  app.post('/skills/namespace/:namespace/update', async (c) => {
    const namespace = c.req.param('namespace');
    const store = getStore();
    let repo: string | null = null;
    let ref: string | undefined;
    try {
      const skills = store.listSkills({ tag: namespace });
      const sample = skills.find((s) => s.source_ref);
      if (!sample?.source_ref) {
        return c.json({ error: 'no installed skills with source_ref' }, 404);
      }
      repo = sample.source_ref.repo;
      const body = await c.req.json<{ ref?: string }>().catch(() => ({} as { ref?: string }));
      ref = body.ref;
    } finally {
      store.close();
    }
    try {
      const result = await installFromGithub({
        repo: repo!,
        namespace,
        ref,
        overwrite: true,
      });
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  app.delete('/skills/namespace/:namespace', async (c) => {
    try {
      const result = await uninstallNamespace(c.req.param('namespace'));
      return c.json(result);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  // ─── Get single skill ────────────────────────────────────────
  app.get('/skills/:id', (c) => {
    const store = getStore();
    try {
      const skill = store.getSkill(c.req.param('id'));
      if (!skill) return c.json({ error: 'not found' }, 404);
      return c.json(skill);
    } finally {
      store.close();
    }
  });

  // ─── Create / Upsert ─────────────────────────────────────────
  app.post('/skills', async (c) => {
    const body = await c.req.json<UpsertSkillInput>();
    if (!body.id || !body.name || !body.prompt_body) {
      return c.json({ error: 'id, name, prompt_body required' }, 400);
    }
    const store = getStore();
    try {
      const skill = store.upsertSkill(body);
      return c.json(skill, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    } finally {
      store.close();
    }
  });

  // ─── Partial update ──────────────────────────────────────────
  app.patch('/skills/:id', async (c) => {
    const id = c.req.param('id');
    const store = getStore();
    try {
      const existing = store.getSkill(id);
      if (!existing) return c.json({ error: 'not found' }, 404);

      const body = await c.req.json<Partial<SkillDefinition>>();
      const skill = store.upsertSkill({
        id,
        name: body.name ?? existing.name,
        description: body.description ?? existing.description,
        slash_command: body.slash_command !== undefined ? body.slash_command : existing.slash_command,
        prompt_body: body.prompt_body ?? existing.prompt_body,
        scope: body.scope ?? existing.scope,
        enabled: body.enabled ?? existing.enabled,
        allowed_tools: body.allowed_tools !== undefined ? body.allowed_tools : existing.allowed_tools,
        model_override: body.model_override !== undefined ? body.model_override : existing.model_override,
        provider_override: body.provider_override !== undefined ? body.provider_override : existing.provider_override,
        context_mode: body.context_mode ?? existing.context_mode,
        variables: body.variables ?? existing.variables,
        sort_order: body.sort_order ?? existing.sort_order,
        tags: body.tags ?? existing.tags,
        path_patterns: body.path_patterns !== undefined ? body.path_patterns : existing.path_patterns,
        author: body.author !== undefined ? body.author : existing.author,
        version: body.version ?? existing.version,
        source: body.source ?? existing.source,
      });
      return c.json(skill);
    } finally {
      store.close();
    }
  });

  // ─── Delete ──────────────────────────────────────────────────
  app.delete('/skills/:id', (c) => {
    const store = getStore();
    try {
      store.deleteSkill(c.req.param('id'));
      return c.json({ ok: true });
    } finally {
      store.close();
    }
  });

  // ─── Duplicate ───────────────────────────────────────────────
  app.post('/skills/:id/duplicate', (c) => {
    const store = getStore();
    try {
      const original = store.getSkill(c.req.param('id'));
      if (!original) return c.json({ error: 'not found' }, 404);

      // Generate a unique clone id
      let cloneId = `${original.id}-copy`;
      let counter = 1;
      while (store.getSkill(cloneId)) {
        counter++;
        cloneId = `${original.id}-copy-${counter}`;
      }

      const clone = store.upsertSkill({
        id: cloneId,
        name: `${original.name} (copy)`,
        description: original.description,
        slash_command: null, // avoid collision
        prompt_body: original.prompt_body,
        scope: original.scope,
        enabled: false, // start disabled
        allowed_tools: original.allowed_tools,
        model_override: original.model_override,
        provider_override: original.provider_override,
        context_mode: original.context_mode,
        variables: original.variables,
        sort_order: original.sort_order,
        tags: original.tags,
        path_patterns: original.path_patterns,
        author: original.author,
        version: original.version,
        source: 'user',
      });
      return c.json(clone, 201);
    } finally {
      store.close();
    }
  });

  // ─── Export ──────────────────────────────────────────────────
  app.get('/skills/:id/export', (c) => {
    const store = getStore();
    try {
      const json = store.exportSkill(c.req.param('id'));
      return c.json(JSON.parse(json));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('not found')) return c.json({ error: 'not found' }, 404);
      return c.json({ error: msg }, 400);
    } finally {
      store.close();
    }
  });

  // ─── Import ──────────────────────────────────────────────────
  app.post('/skills/import', async (c) => {
    const body = await c.req.json<{ skill: Record<string, unknown>; overwrite?: boolean }>();
    if (!body.skill) return c.json({ error: 'skill object required' }, 400);

    const store = getStore();
    try {
      const skill = store.importSkill(JSON.stringify(body.skill), body.overwrite ?? false);
      return c.json(skill, 201);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    } finally {
      store.close();
    }
  });

  // ─── Usage stats ─────────────────────────────────────────────
  app.get('/skills/:id/usage', (c) => {
    const store = getStore();
    try {
      const stats = store.getSkillUsageStats(c.req.param('id'));
      return c.json(stats);
    } finally {
      store.close();
    }
  });

  // ─── Health (alias for usage) ─────────────────────────────────
  // Identical payload to /usage but a more obvious URL for the dashboard
  // "skill health" panel. Returns total_invocations + last_used (legacy)
  // plus success_rate and top_error_codes (added by migration 056).
  app.get('/skills/:id/health', (c) => {
    const store = getStore();
    try {
      const stats = store.getSkillUsageStats(c.req.param('id'));
      return c.json(stats);
    } finally {
      store.close();
    }
  });

  return app;
}
