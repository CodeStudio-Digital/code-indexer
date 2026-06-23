/**
 * Session-level skill routes — resolve active skills per session,
 * toggle skills on/off per session, and the slash command list.
 */
import type { Hono } from 'hono';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseIdParam, notFound } from '../_helpers.js';

function getSkillStore() {
  const config = loadConfig();
  return new SkillStore(config.dbPath);
}

export function mountCoderSkillsRoutes(
  app: Hono,
  deps: ServerDeps,
  _runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;

  /**
   * GET /api/coder/sessions/:id/skills — resolved skills for a session.
   * Returns the final merged list (global + project + session overrides).
   */
  app.get('/api/coder/sessions/:id/skills', (c) => {
    const sessionId = parseIdParam(c);
    if (!Number.isFinite(sessionId)) return c.json({ error: 'invalid session id' }, 400);

    const session = sessionStore.getSession(sessionId);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const store = getSkillStore();
    try {
      const resolved = store.resolveActiveSkills(sessionId, session.project_id);
      // Also return all available skills (enabled or not) with session override info
      const allSkills = store.listSkills({
        scope: 'global',
      });
      const projectSkills = store.listSkills({
        scope: String(session.project_id),
      });
      const combined = [...allSkills, ...projectSkills];
      const overrides = store.getSessionSkillConfig(sessionId);

      const withStatus = combined.map((skill) => ({
        ...skill,
        session_enabled: overrides.has(skill.id)
          ? overrides.get(skill.id)
          : skill.enabled,
        is_active: resolved.some((r) => r.id === skill.id),
      }));

      return c.json({ skills: withStatus, active_count: resolved.length });
    } finally {
      store.close();
    }
  });

  /**
   * PUT /api/coder/sessions/:id/skills/:skillId — toggle skill for session.
   */
  app.put('/api/coder/sessions/:id/skills/:skillId', async (c) => {
    const sessionId = parseIdParam(c);
    const skillId = c.req.param('skillId');
    if (!Number.isFinite(sessionId)) return c.json({ error: 'invalid session id' }, 400);

    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400);

    const store = getSkillStore();
    try {
      store.setSessionSkillEnabled(sessionId, skillId, body.enabled);
      return c.json({ ok: true, skill_id: skillId, enabled: body.enabled });
    } finally {
      store.close();
    }
  });

  /**
   * GET /api/coder/skills/slash-commands — list all available slash commands.
   * Used by the Composer for autocomplete.
   */
  app.get('/api/coder/skills/slash-commands', (c) => {
    const store = getSkillStore();
    try {
      const skills = store.listSkills({ enabled: true });
      const commands = skills
        .filter((s) => s.slash_command)
        .map((s) => ({
          id: s.id,
          command: s.slash_command,
          name: s.name,
          description: s.description,
          context_mode: s.context_mode,
        }));
      return c.json({ commands });
    } finally {
      store.close();
    }
  });
}
