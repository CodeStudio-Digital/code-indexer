import type { Hono } from 'hono';
import { normalizeAppMasterConversation } from '@mcp/api-handlers/app-studio/app-team-session.js';
import { resolveEffectiveMasterRuntime } from '@mcp/company/services/subordinate/role-runtime.js';
import { getCompanyOrchestrator } from '../../../sse/companyOrchestrator.js';
import type { ServerDeps } from '../../deps.js';
import { notFound, parseIdParam, parseJsonBody } from '../_helpers.js';
import { applyAppTeamConfigPatch, readAppTeamConfig, type AppTeamConfigPatch } from './team-config.js';

export function mountAppStudioTeamConfigRoutes(app: Hono, deps: ServerDeps): void {
  app.get('/api/app-studio/apps/:id/team/config', (c) => {
    const id = parseIdParam(c);
    const appSession = deps.appStudioStore.getSession(id);
    if (!appSession?.company_session_id) return notFound(c, 'App team not found');
    const company = deps.companyStore.getCompanySession(appSession.company_session_id);
    if (!company || company.runtime_kind !== 'app_studio') return notFound(c, 'App team not found');
    try {
      return c.json(readAppTeamConfig(company.config_json, company.id, company.status));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.patch('/api/app-studio/apps/:id/team/config', async (c) => {
    const id = parseIdParam(c);
    const appSession = deps.appStudioStore.getSession(id);
    if (!appSession?.company_session_id) return notFound(c, 'App team not found');
    const company = deps.companyStore.getCompanySession(appSession.company_session_id);
    if (!company || company.runtime_kind !== 'app_studio') return notFound(c, 'App team not found');
    const body = await parseJsonBody<AppTeamConfigPatch>(c);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: 'Invalid body' }, 400);
    const unsupported = Object.keys(body).filter((key) => key !== 'operational_rules' && key !== 'roles');
    if (unsupported.length > 0) return c.json({ error: `Unsupported App team config: ${unsupported.join(', ')}` }, 400);
    if (body.operational_rules === undefined && body.roles === undefined) return c.json({ error: 'No App team config changes provided' }, 400);
    try {
      const next = applyAppTeamConfigPatch(company.config_json, body);
      resolveEffectiveMasterRuntime({
        configJson: next.configJson,
        runtimeKind: 'app_studio',
        dispatchSource: 'app_studio',
      });
      if (body.roles) {
        const orchestrator = getCompanyOrchestrator(company.id);
        if (orchestrator) {
          await orchestrator.applyConfigPatch({
            role_assignments: next.roles.filter((role) => role.role !== 'master'),
            allowed_models: next.allowedModels,
          });
        }
      }
      deps.companyStore.updateCompanySessionConfig(company.id, next.configJson);
      if (company.master_session_id) {
        const coordinator = deps.sessionStore.getSession(company.master_session_id);
        if (coordinator) normalizeAppMasterConversation(deps, next.configJson, coordinator);
      }
      deps.appStudioStore.appendEvent(
        id,
        'team.config_updated',
        'company_session',
        String(company.id),
        JSON.stringify({ changed_keys: next.changedKeys }),
      );
      const fresh = deps.companyStore.getCompanySession(company.id);
      return c.json(readAppTeamConfig(fresh?.config_json ?? next.configJson, company.id, company.status));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
