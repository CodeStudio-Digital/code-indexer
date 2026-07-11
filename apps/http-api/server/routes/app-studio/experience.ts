import type { Hono } from 'hono';
import { parseAppWireframePlan } from '@mcp/app-studio/experience/types.js';
import { notFound, parseIdParam, parseJsonBody } from '../_helpers.js';
import type { ServerDeps } from '../../deps.js';

export function mountAppStudioExperienceRoutes(app: Hono, deps: ServerDeps): void {
  app.patch('/api/app-studio/sessions/:id/build-groups/:groupId', async (c) => {
    const id = parseIdParam(c);
    const session = deps.appStudioStore.getSession(id);
    if (!session) return notFound(c);
    const groupId = c.req.param('groupId');
    const body = await parseJsonBody<{ action?: 'approve' | 'reopen'; feedback?: string }>(c);
    if (body.action !== 'approve' && body.action !== 'reopen') return c.json({ error: "action must be 'approve' or 'reopen'." }, 400);
    const revision = deps.appStudioStore.getLatestApprovedWireframeRevision(id);
    const plan = parseAppWireframePlan(revision?.wireframe_json);
    if (!revision || !plan) return c.json({ error: 'No approved wireframe build plan.' }, 409);
    const group = plan.build_groups.find((item) => item.id === groupId);
    if (!group) return c.json({ error: `Unknown build group '${groupId}'.` }, 404);
    const states = deps.appStudioStore.listBuildGroups(revision.id);
    const state = states.find((item) => item.group_id === groupId);
    if (body.action === 'approve') {
      if (state?.status !== 'review') return c.json({ error: `Build group '${groupId}' is not waiting for review.` }, 409);
      const current = [...plan.build_groups].sort((a, b) => a.sequence - b.sequence).find((item) => states.find((row) => row.group_id === item.id)?.status !== 'approved');
      if (current?.id !== groupId) return c.json({ error: `Build group '${current?.id ?? 'none'}' must be completed first.` }, 409);
      deps.appStudioStore.approveBuildGroup(id, revision.id, groupId);
    } else {
      const feedback = body.feedback?.trim();
      if (!feedback) return c.json({ error: 'feedback is required to reopen a build group.' }, 400);
      const affected = new Set<string>([groupId]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const candidate of plan.build_groups) {
          if (!affected.has(candidate.id) && candidate.depends_on.some((dep) => affected.has(dep))) {
            affected.add(candidate.id); changed = true;
          }
        }
      }
      const taskIds = plan.tasks.filter((task) => affected.has(task.group_id)).map((task) => task.id);
      deps.appStudioStore.reopenBuildGroup(id, revision.id, [...affected], taskIds, feedback);
    }
    return c.json({ groups: deps.appStudioStore.listBuildGroups(revision.id), tasks: deps.appStudioStore.listBuildTaskEvidence(revision.id) });
  });
}
