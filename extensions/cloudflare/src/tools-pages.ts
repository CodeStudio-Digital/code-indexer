/**
 * Cloudflare Pages projects and deployments.
 */
import { contributeTool } from '@mcp/plugin-sdk/define.js';
import type { PluginToolContext } from '@mcp/plugin-sdk/define.js';
import { cfAcct, cfAcctPaged, list, ok, parseJson, reqString } from './lib.js';

interface PagesProject {
  name: string;
  subdomain?: string;
  latest_deployment?: { created_on?: string; url?: string };
}

export const pagesTools = [
  contributeTool({
    name: 'cf_pages_list',
    description: 'List Pages projects',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: {} },
    handler: async (_a, ctx: PluginToolContext) => {
      const ps = await cfAcctPaged<PagesProject>(ctx, '/pages/projects');
      return list(ps, (p) => `- ${p.name}${p.subdomain ? ` (${p.subdomain})` : ''}`, 'No Pages projects.');
    },
  }),
  contributeTool({
    name: 'cf_pages_get',
    description: 'Get Pages project details',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    handler: async (a, ctx) => {
      const p = await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}`);
      return ok('Pages project details.', { details: p });
    },
  }),
  contributeTool({
    name: 'cf_pages_create',
    description: 'Create a Pages project using the Cloudflare project body',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { body: { type: 'object' } }, required: ['body'] },
    handler: async (a, ctx) => {
      const p = await cfAcct(ctx, '/pages/projects', { method: 'POST', body: JSON.stringify(parseJson(a.body, {})) });
      return ok('Pages project created.', { details: p });
    },
  }),
  contributeTool({
    name: 'cf_pages_update',
    description: 'Update a Pages project using the Cloudflare project body',
    riskLevel: 'write',
    mutates: true,
    parameters: { type: 'object', properties: { project: { type: 'string' }, body: { type: 'object' } }, required: ['project', 'body'] },
    handler: async (a, ctx) => {
      const p = await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}`, {
        method: 'PATCH',
        body: JSON.stringify(parseJson(a.body, {})),
      });
      return ok('Pages project updated.', { details: p });
    },
  }),
  contributeTool({
    name: 'cf_pages_delete',
    description: 'Delete a Pages project',
    riskLevel: 'admin',
    mutates: true,
    parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    handler: async (a, ctx) => {
      await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}`, { method: 'DELETE' });
      return ok('Pages project deleted.');
    },
  }),
  contributeTool({
    name: 'cf_pages_deployments',
    description: 'List recent deployments for a Pages project',
    riskLevel: 'read',
    mutates: false,
    parameters: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
    handler: async (a, ctx) => {
      const ds = await cfAcctPaged<{ id: string; created_on?: string; url?: string }>(
        ctx,
        `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}/deployments`,
      );
      return list(ds.slice(0, 50), (d) => `- ${d.created_on ?? '?'} ${d.url ?? ''} (${d.id})`, 'No deployments.');
    },
  }),
  contributeTool({
    name: 'cf_pages_deployment_get',
    description: 'Get Pages deployment details',
    riskLevel: 'read',
    mutates: false,
    parameters: {
      type: 'object',
      properties: { project: { type: 'string' }, deploymentId: { type: 'string' } },
      required: ['project', 'deploymentId'],
    },
    handler: async (a, ctx) => {
      const d = await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}/deployments/${reqString(a, 'deploymentId')}`);
      return ok('Pages deployment details.', { details: d });
    },
  }),
  contributeTool({
    name: 'cf_pages_deployment_delete',
    description: 'Delete a Pages deployment',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { project: { type: 'string' }, deploymentId: { type: 'string' } },
      required: ['project', 'deploymentId'],
    },
    handler: async (a, ctx) => {
      await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}/deployments/${reqString(a, 'deploymentId')}`, { method: 'DELETE' });
      return ok('Pages deployment deleted.');
    },
  }),
  contributeTool({
    name: 'cf_pages_deployment_retry',
    description: 'Retry a Pages deployment',
    riskLevel: 'write',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { project: { type: 'string' }, deploymentId: { type: 'string' } },
      required: ['project', 'deploymentId'],
    },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}/deployments/${reqString(a, 'deploymentId')}/retry`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return ok('Pages deployment retry started.', { details: r });
    },
  }),
  contributeTool({
    name: 'cf_pages_deployment_rollback',
    description: 'Rollback to a Pages deployment',
    riskLevel: 'admin',
    mutates: true,
    parameters: {
      type: 'object',
      properties: { project: { type: 'string' }, deploymentId: { type: 'string' } },
      required: ['project', 'deploymentId'],
    },
    handler: async (a, ctx) => {
      const r = await cfAcct(ctx, `/pages/projects/${encodeURIComponent(reqString(a, 'project'))}/deployments/${reqString(a, 'deploymentId')}/rollback`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      return ok('Pages rollback started.', { details: r });
    },
  }),
];
