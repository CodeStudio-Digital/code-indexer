/** Durable Company knowledge, available without a sandbox. */
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { err } from '@mcp/agent-runtime-host/tool-result.js';
import { okStructured } from '@mcp/code-agent/core/model-output.js';
import type { CompanyDriveStore } from '../services/CompanyDriveStore.js';
import { CompanyDocs, normalizeDocServiceId, validateDocPath } from '../services/CompanyDocs.js';
import { getSandboxManager } from '@mcp/services/sandbox/index.js';
import { resolveDriver } from '@mcp/services/sandbox/drivers/driver-factory.js';

async function knowledge(ctx: ToolContext, service?: string): Promise<CompanyDocs> {
  const company = ctx.companyContext;
  const orch = company?.orchestrator as { driveStore?: CompanyDriveStore; effectiveSessionId?: string } | undefined;
  if (!orch?.driveStore) throw new Error('Company knowledge store unavailable');
  const svc = normalizeDocServiceId(service ?? company?.sandbox?.serviceId);
  let binding = company?.sandbox ?? null;
  if (!binding || normalizeDocServiceId(binding.serviceId) !== svc) {
    binding = null;
    const id = orch.effectiveSessionId ?? company?.companySessionId;
    if (id) {
      const manager = getSandboxManager();
      const sb = svc === 'main' ? manager.get(id) : manager.getService(id, svc);
      if (sb?.containerId) {
        const driver = await resolveDriver().catch(() => null);
        if (driver) binding = { driver, containerId: sb.containerId, workdir: sb.workdir, previewUrl: sb.previewUrl, serviceId: svc };
      }
    }
  }
  return new CompanyDocs(orch.driveStore, svc, binding);
}

const serviceParam = { type: 'string', description: 'Service namespace; defaults to this agent service or main. Works without a container.' };
const versionParam = { type: 'string', description: 'Version returned by docs_read, required to overwrite an existing durable document. Omit only when creating a new document.' };
const pathParam = { type: 'string', description: 'Relative documentation path, e.g. decisions/0001-auth.md.' };
const failure = (name: string, error: unknown) => err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
const docsWrite: CoderTool = {
  name: 'docs_write', source: 'native',
  description: 'Persist Company knowledge: ADRs, architecture, API contracts and runbooks. The durable store is authoritative; an optional sandbox receives a working copy. Use write_shared_file for work artifacts. Read current content before updating.',
  parameters: { type: 'object', properties: { path: pathParam, expected_version: versionParam, content: { type: 'string' }, service: serviceParam }, required: ['path', 'content'], additionalProperties: false },
  handler: async (args, ctx) => {
    try { return okStructured(await (await knowledge(ctx, args.service as string | undefined)).write(String(args.path ?? ''), String(args.content ?? ''), { role: ctx.companyContext?.agentRole, agentRunId: ctx.companyContext?.agentRunId }, typeof args.expected_version === 'string' ? args.expected_version : null)); }
    catch (error) { return failure('docs_write', error); }
  },
};
const docsRead: CoderTool = {
  name: 'docs_read', source: 'native',
  description: 'Read Company knowledge with content version and origin. Works without a sandbox; legacy sandbox-only files remain readable.',
  parameters: { type: 'object', properties: { path: pathParam, service: serviceParam }, required: ['path'], additionalProperties: false },
  handler: async (args, ctx) => {
    try {
      const doc = await (await knowledge(ctx, args.service as string | undefined)).read(String(args.path ?? ''));
      return doc ? okStructured(doc) : err('docs_read: document not found');
    } catch (error) { return failure('docs_read', error); }
  },
};
const docsList: CoderTool = {
  name: 'docs_list', source: 'native',
  description: 'Discover existing Company knowledge before starting work or creating notes. Returns path, service, origin and modification time; works while containers are offline.',
  parameters: { type: 'object', properties: { service: serviceParam }, additionalProperties: false },
  handler: async (args, ctx) => {
    try { const docs = await knowledge(ctx, args.service as string | undefined); return okStructured({ service: docs.service, entries: await docs.list() }); }
    catch (error) { return failure('docs_list', error); }
  },
};
const docsSearch: CoderTool = {
  name: 'docs_search', source: 'native',
  description: 'Search Company knowledge locally without embeddings or a running sandbox. Returns up to 20 paths, versions and excerpts; read selected documents with docs_read.',
  parameters: { type: 'object', properties: { query: { type: 'string' }, service: serviceParam }, required: ['query'], additionalProperties: false },
  handler: async (args, ctx) => {
    try {
      const query = String(args.query ?? '').trim().toLowerCase();
      if (!query) return err('docs_search: query required');
      const docs = await knowledge(ctx, args.service as string | undefined);
      const hits = [];
      for (const entry of await docs.list()) {
        if (!entry.path.endsWith('.md')) continue;
        const doc = await docs.read(entry.path);
        if (!doc) continue;
        const offset = doc.content.toLowerCase().indexOf(query);
        if (offset < 0 && !entry.path.toLowerCase().includes(query)) continue;
        hits.push({ ...entry, version: doc.version, excerpt: doc.content.slice(Math.max(0, offset - 100), Math.max(0, offset) + 400) });
        if (hits.length >= 20) break;
      }
      return okStructured({ service: docs.service, hits });
    } catch (error) { return failure('docs_search', error); }
  },
};
const docsIndexUpdate: CoderTool = {
  name: 'docs_index_update', source: 'native',
  description: 'Persist the documentation table of contents as index.json. Sections have title, optional relative path and children (maximum six levels).',
  parameters: { type: 'object', properties: { service: serviceParam, expected_version: versionParam, sections: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, path: pathParam, children: { type: 'array', items: { type: 'object', additionalProperties: true } } }, required: ['title'], additionalProperties: false } } }, required: ['sections'], additionalProperties: false },
  handler: async (args, ctx) => {
    try {
      const validate = (items: unknown, depth: number): void => {
        if (!Array.isArray(items) || depth > 6) throw new Error('Invalid sections or nesting exceeds six levels');
        for (const item of items) {
          if (!item || typeof item !== 'object' || typeof item.title !== 'string' || !item.title.trim()) throw new Error('entry.title required');
          if (item.path !== undefined) { if (typeof item.path !== 'string') throw new Error('entry.path must be a string'); validateDocPath(item.path); }
          if (item.children !== undefined) validate(item.children, depth + 1);
        }
      };
      validate(args.sections, 0);
      return okStructured(await (await knowledge(ctx, args.service as string | undefined)).write('index.json', JSON.stringify({ sections: args.sections }, null, 2), {}, typeof args.expected_version === 'string' ? args.expected_version : null));
    } catch (error) { return failure('docs_index_update', error); }
  },
};
const docsDelete: CoderTool = {
  name: 'docs_delete', source: 'native',
  description: 'Delete obsolete Company knowledge durably. Prefer superseding ADRs that preserve history. Offline sandbox copies cannot resurrect the document.',
  parameters: { type: 'object', properties: { path: pathParam, service: serviceParam }, required: ['path'], additionalProperties: false },
  handler: async (args, ctx) => {
    try { return okStructured(await (await knowledge(ctx, args.service as string | undefined)).delete(String(args.path ?? ''))); }
    catch (error) { return failure('docs_delete', error); }
  },
};
export const docsTools: CoderTool[] = [docsWrite, docsRead, docsList, docsSearch, docsIndexUpdate, docsDelete];
