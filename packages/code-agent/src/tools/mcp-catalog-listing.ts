import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ResultSchema, ToolSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ServerConnection } from './mcp-connection-types.js';
export type ListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];


export interface ValidationIssueLike {
  path?: unknown;
  message?: unknown;
}


/**
 * The MCP SDK validates `tools/list` as one Zod object. One malformed tool
 * therefore rejects every valid sibling before callers can isolate it.
 */
export function isToolListValidationError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const issues = (error as { issues?: unknown }).issues;
  return Array.isArray(issues) && issues.some((issue) => {
    const path = (issue as ValidationIssueLike | null)?.path;
    return Array.isArray(path) && path[0] === 'tools';
  });
}


export function rawToolName(value: unknown, index: number): string {
  if (value && typeof value === 'object') {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string' && name.trim()) return name;
  }
  return `#${index}`;
}


export function firstValidationMessage(issues: readonly ValidationIssueLike[]): string {
  for (const issue of issues) {
    if (typeof issue.message === 'string' && issue.message.trim()) return issue.message;
  }
  return 'invalid MCP tool definition';
}


async function listToolPage(
    serverId: string,
    conn: ServerConnection,
    cursor: string | undefined,
    options: { signal?: AbortSignal; timeout: number },
  ): Promise<{ tools: ListedTool[]; nextCursor?: string }> {
    const params = cursor ? { cursor } : undefined;
    if (!conn.lenientToolListing) {
      try {
        return await conn.client.listTools(params, options);
      } catch (error) {
        if (!isToolListValidationError(error)) throw error;
        conn.lenientToolListing = true;
        console.warn(
          `[mcp-ext] server "${serverId}" returned a malformed tools/list catalogue; ` +
            'switching this connection to per-tool validation',
        );
      }
    }

    const raw = await conn.client.request({ method: 'tools/list', ...(params ? { params } : {}) }, ResultSchema, options);
    if (!Array.isArray(raw.tools)) {
      throw new Error(`External MCP server "${serverId}" returned tools/list without a tools array`);
    }

    const valid: ListedTool[] = [];
    const invalid: string[] = [];
    for (let index = 0; index < raw.tools.length; index++) {
      const candidate = raw.tools[index];
      const parsed = ToolSchema.safeParse(candidate);
      if (parsed.success) {
        valid.push(parsed.data);
        continue;
      }
      invalid.push(
        `${rawToolName(candidate, index)} (${firstValidationMessage(parsed.error.issues)})`,
      );
    }

    const signature = invalid.join('|');
    if (invalid.length > 0 && signature !== conn.reportedInvalidToolSignature) {
      conn.reportedInvalidToolSignature = signature;
      console.warn(
        `[mcp-ext] server "${serverId}" skipped ${invalid.length} invalid tool definition(s): ` +
          invalid.join(', '),
      );
    }
    if (raw.nextCursor !== undefined && typeof raw.nextCursor !== 'string') {
      throw new Error('MCP tools/list returned an invalid nextCursor');
    }
    return { tools: valid, nextCursor: raw.nextCursor as string | undefined };
  }

/** One bounded snapshot, published only after every page has been acquired. */
export async function listToolsFromConnection(
  serverId: string,
  conn: ServerConnection,
  options: { signal?: AbortSignal; timeoutMs?: number; maxPages?: number } = {},
): Promise<ListedTool[]> {
  if ((options.timeoutMs !== undefined && !Number.isFinite(options.timeoutMs))
    || (options.maxPages !== undefined && !Number.isInteger(options.maxPages))) throw new Error('Invalid MCP catalogue budget');
  const duration = Math.min(60_000, Math.max(1, options.timeoutMs ?? 30_000));
  const deadline = Date.now() + duration;
  const maxPages = Math.min(64, Math.max(1, options.maxPages ?? 64));
  const seenCursors = new Set<string>();
  const tools = new Map<string, ListedTool>();
  let cursor: string | undefined;
  let bytes = 0;
  for (let page = 0; page < maxPages; page++) {
    options.signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`MCP catalogue deadline exceeded for ${serverId}`);
    const result = await listToolPage(serverId, conn, cursor, { signal: options.signal, timeout: remaining });
    bytes += Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes > 16 * 1024 * 1024) throw new Error('MCP catalogue exceeds 16 MiB budget');
    for (const tool of result.tools) {
      const previous = tools.get(tool.name);
      if (previous && JSON.stringify(previous) !== JSON.stringify(tool)) {
        throw new Error(`MCP catalogue changed during pagination: ${tool.name}`);
      }
      tools.set(tool.name, tool);
      if (tools.size > 10_000) throw new Error('MCP catalogue exceeds 10000 tools');
    }
    cursor = result.nextCursor;
    if (!cursor) return [...tools.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (seenCursors.has(cursor)) throw new Error('MCP catalogue repeated its pagination cursor');
    seenCursors.add(cursor);
  }
  throw new Error('MCP catalogue exceeds pagination budget');
}
