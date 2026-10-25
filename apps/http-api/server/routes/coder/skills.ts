/**
 * Session-level skill routes — resolve active skills per session,
 * toggle skills on/off per session, and the slash command list.
 */
import type { Hono } from 'hono';
import { SkillStore } from '@mcp/store/skill-store.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import { resolveActiveWorkspaceSkills } from '@mcp/code-agent/skills/workspace-skills.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseSessionIdParam, notFound } from '../_helpers.js';

function getSkillStore() {
  const config = loadConfig();
  return new SkillStore(config.dbPath);
}

function sessionProjectIds(session: {
  project_id: number | null;
  linked_projects: readonly { project_id: number }[];
}, isCurrentProject: (projectId: number) => boolean): number[] {
  const ids = new Set<number>();
  if (session.project_id != null && isCurrentProject(session.project_id)) {
    ids.add(session.project_id);
  }
  for (const project of session.linked_projects) {
    if (isCurrentProject(project.project_id)) ids.add(project.project_id);
  }
  return [...ids];
}

function activeSkillProjection(
  tools: Readonly<Record<string, unknown>>,
): string[] | undefined {
  if (!Object.hasOwn(tools, 'active_skills')) return undefined;
  const value = tools.active_skills;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function availableSkills(
  store: SkillStore,
  projectIds: readonly number[],
) {
  const definitions = new Map(
    store.listSkills({ scope: 'global' }).map((skill) => [skill.id, skill]),
  );
  for (const projectId of projectIds) {
    for (const skill of store.listSkills({ scope: String(projectId) })) {
      if (!definitions.has(skill.id)) definitions.set(skill.id, skill);
    }
  }
  return [...definitions.values()].sort(
    (left, right) =>
      left.sort_order - right.sort_order ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

export function mountCoderSkillsRoutes(
  app: Hono,
  deps: ServerDeps,
  _runtime: CoderRuntime,
): void {
  const { sessionStore } = deps;

  app.get('/api/coder/skills/suggestions', async c => {
    const sessionId = c.req.query('session_id');
    let projectIds: number[] = [];
    if (sessionId) {
      const session = await sessionStore.getSession(sessionId);
      if (!session) return notFound(c, 'session not found');
      projectIds = sessionProjectIds(session, projectId => {
        const project = deps.db.getProject(projectId);
        return Boolean(project && !project.is_synthetic && project.root_path.trim());
      });
    }
    return c.json({ commands: deps.skillStore.listComposerSkills(
      ['global', ...projectIds.map(String)], c.req.query('query') ?? '', c.req.query('trigger') === '/',
    ) });
  });

  /**
   * GET /api/coder/sessions/:id/skills — resolved skills for a session.
   * Definitions remain in the essential SQLite catalog; the per-session
   * selection comes exclusively from the bundle's state.json.
   */
  app.get('/api/coder/sessions/:id/skills', async (c) => {
    const sessionId = parseSessionIdParam(c);

    const session = await sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'session not found');

    const store = getSkillStore();
    try {
      const projectIds = sessionProjectIds(
        session,
        (projectId) => {
          const project = deps.db.getProject(projectId);
          return Boolean(
            project
            && !project.is_synthetic
            && project.root_path.trim().length > 0
          );
        },
      );
      const explicit = activeSkillProjection(session.state.tools);
      const resolved = resolveActiveWorkspaceSkills(
        store,
        projectIds,
        explicit,
      );
      const activeIds = new Set(resolved.map((skill) => skill.id));
      const withStatus = availableSkills(store, projectIds).map((skill) => ({
        ...skill,
        session_enabled: activeIds.has(skill.id),
        is_active: activeIds.has(skill.id),
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
    const sessionId = parseSessionIdParam(c);
    const skillId = c.req.param('skillId');

    const body = await c.req.json<{ enabled: boolean }>();
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled (boolean) required' }, 400);

    const session = await sessionStore.getSession(sessionId);
    if (!session) return notFound(c, 'session not found');

    const store = getSkillStore();
    try {
      const projectIds = sessionProjectIds(
        session,
        (projectId) => {
          const project = deps.db.getProject(projectId);
          return Boolean(
            project
            && !project.is_synthetic
            && project.root_path.trim().length > 0
          );
        },
      );
      const definitions = availableSkills(store, projectIds);
      if (!definitions.some((skill) => skill.id === skillId)) {
        return notFound(c, 'skill not found for this session');
      }
      const active = new Set(
        resolveActiveWorkspaceSkills(
          store,
          projectIds,
          activeSkillProjection(session.state.tools),
        ).map((skill) => skill.id),
      );
      if (body.enabled) active.add(skillId);
      else active.delete(skillId);
      await sessionStore.setSessionActiveSkills(sessionId, [...active]);
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
