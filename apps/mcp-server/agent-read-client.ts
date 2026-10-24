import { jsonRequest } from './agent-run-http.js';
import { McpAgentRunReader } from './agent-run-reader.js';

/** Application-facing read API. It has no database, admission or mutation methods. */
export function createAgentReadClient(
  port: number,
  transport: (path: string, init?: RequestInit) => Promise<Response>,
): Pick<McpAgentRunReader, 'catalog' | 'list' | 'get'> {
  const context = { config: { dashboard: { port } } };
  const request: typeof jsonRequest = (_context, path, init) => jsonRequest(context, path, init,
    (_url, requestInit) => transport(path, requestInit));
  const reader = new McpAgentRunReader(context, request);
  return { catalog: reader.catalog.bind(reader), list: reader.list.bind(reader), get: reader.get.bind(reader) };
}
