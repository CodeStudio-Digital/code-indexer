/**
 * Session-level skill routes — resolve active skills per session,
 * toggle skills on/off per session, slash command list, and skill invocation.
 */
import type { Hono } from 'hono';
import { SkillStore } from '../../../../../store/skill-store.js';
import { loadConfig } from '../../../../../utils/config.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';

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
    const sessionId = parseInt(c.req.param('id'), 10);
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
    const sessionId = parseInt(c.req.param('id'), 10);
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

  /**
   * POST /api/coder/sessions/:id/invoke-skill — invoke a skill via slash command.
   * Wraps the skill prompt as a user message with a skill prefix.
   */
  app.post('/api/coder/sessions/:id/invoke-skill', async (c) => {
    const sessionId = parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(sessionId)) return c.json({ error: 'invalid session id' }, 400);

    const session = sessionStore.getSession(sessionId);
    if (!session) return c.json({ error: 'session not found' }, 404);

    const body = await c.req.json<{ skill_id: string; input?: string }>();
    if (!body.skill_id) return c.json({ error: 'skill_id required' }, 400);

    const store = getSkillStore();
    try {
      const skill = store.getSkill(body.skill_id);
      if (!skill) return c.json({ error: 'skill not found' }, 404);

      // Log usage
      store.logSkillUsage({
        session_id: sessionId,
        skill_id: body.skill_id,
        invoked_by: 'user',
        input_text: body.input,
      });

      // Return the skill-wrapped message for the frontend to send via the
      // normal stream endpoint. The frontend composes this into the user message.
      const message = body.input
        ? `[Skill: ${skill.name}]\n\n${skill.prompt_body}\n\nUser input: ${body.input}`
        : `[Skill: ${skill.name}]\n\n${skill.prompt_body}`;

      return c.json({ message, skill_name: skill.name });
    } finally {
      store.close();
    }
  });
}
