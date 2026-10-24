import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export interface ResourcePageOptions { kind?: 'all' | 'resources' | 'templates'; cursor?: string; signal?: AbortSignal }
export interface ResourcePage {
  resources: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
  templates: Array<{ uriTemplate: string; name: string; description?: string; mimeType?: string }>;
  nextResourceCursor?: string; nextTemplateCursor?: string;
}
type ResourceClient = Pick<Client, 'listResources' | 'listResourceTemplates' | 'readResource'>;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;
const methodMissing = (cause: unknown) => (cause as { code?: number } | undefined)?.code === -32601;

/** One protocol page per kind, never an unbounded cursor-draining loop. */
export async function listMcpResourcePage(client: ResourceClient, options: ResourcePageOptions = {}): Promise<ResourcePage> {
  options.signal?.throwIfAborted();
  const kind = options.kind ?? 'all';
  if (!['all', 'resources', 'templates'].includes(kind) || (kind === 'all' && options.cursor != null)) throw new Error('A resource cursor requires kind resources or templates');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
  const request = { signal, timeout: 10000 };
  const params = options.cursor == null ? undefined : { cursor: options.cursor };
  const page: ResourcePage = { resources: [], templates: [] };
  const pending = [];
  if (kind !== 'templates') pending.push((async () => {
    try {
      const result = await client.listResources(params, request);
      if (result.resources.length > 1000 || Buffer.byteLength(JSON.stringify(result)) > MAX_METADATA_BYTES) throw new Error('MCP resource page exceeds the limit; server must paginate its catalog');
      page.resources = result.resources.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
      page.nextResourceCursor = result.nextCursor;
    } catch (cause) { if (!methodMissing(cause)) throw cause; }
  })());
  if (kind !== 'resources') pending.push((async () => {
    try {
      const result = await client.listResourceTemplates(params, request);
      if (result.resourceTemplates.length > 1000 || Buffer.byteLength(JSON.stringify(result)) > MAX_METADATA_BYTES) throw new Error('MCP template page exceeds the limit; server must paginate its catalog');
      page.templates = result.resourceTemplates.map(({ uriTemplate, name, description, mimeType }) => ({ uriTemplate, name, description, mimeType }));
      page.nextTemplateCursor = result.nextCursor;
    } catch (cause) { if (!methodMissing(cause)) throw cause; }
  })());
  const settled = await Promise.allSettled(pending);
  signal.throwIfAborted();
  const failure = settled.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return page;
}

export async function readMcpResource(client: ResourceClient, uri: string, callerSignal?: AbortSignal): Promise<{ contents: string; mimeType?: string }> {
  callerSignal?.throwIfAborted();
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const result = await client.readResource({ uri }, { signal, timeout: 15000 });
  signal.throwIfAborted();
  if (result.contents.length > 1024) throw new Error('MCP resource contains too many content blocks');
  const parts: string[] = []; let size = 0, mimeType: string | undefined;
  for (const content of result.contents) {
    mimeType ??= content.mimeType;
    if ('text' in content) { size += Buffer.byteLength(content.text); parts.push(content.text); }
    else { size += content.blob.length; parts.push(`[binary resource: ${content.blob.length} base64 chars, mimeType=${content.mimeType ?? 'unknown'}; binary content is not rendered as text]`); }
    if (size > MAX_CONTENT_BYTES) throw new Error('MCP resource exceeds the 8 MiB read limit; use a paginated resource or tool');
  }
  return { contents: parts.join('\n'), mimeType };
}
