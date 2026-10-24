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


export async function listToolsFromConnection(
    serverId: string,
    conn: ServerConnection,
  ): Promise<ListedTool[]> {
    if (!conn.lenientToolListing) {
      try {
        return (await conn.client.listTools()).tools;
      } catch (error) {
        if (!isToolListValidationError(error)) throw error;
        conn.lenientToolListing = true;
        console.warn(
          `[mcp-ext] server "${serverId}" returned a malformed tools/list catalogue; ` +
            'switching this connection to per-tool validation',
        );
      }
    }

    const raw = await conn.client.request({ method: 'tools/list' }, ResultSchema);
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
    return valid;
  }
