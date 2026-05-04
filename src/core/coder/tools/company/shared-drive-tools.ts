/**
 * Shared-drive tools for company agents.
 *
 * Every agent in a company session — master and subordinates — gets the
 * same five tools. They write to and read from a single persistent file
 * drive scoped to the company template (or to the session, when the
 * session is template-less). Use them to exchange large documents
 * (specs, dumps, transcripts, reports) without inflating board posts
 * or inbox messages.
 *
 * Routing: each tool resolves the scope via
 * `companyContext.orchestrator.driveStore.resolveScopeKey()` so callers
 * never have to think about the underlying storage layout.
 */

import type { CoderTool, ToolResult } from '../../core/tool.js';
import { ok, err } from '../../core/tool.js';

const WRITE_DESC =
  'Write (create or overwrite) a file in the company shared drive.\n' +
  "USE: when you need to hand a peer or the master a document too large to inline (>1KB) — specs, plans, dumps, reports, transcripts.\n" +
  'After writing, mention the path in your message (board post, ask_master, send_to_agent) so the recipient knows what to read.\n' +
  "DON'T: store ephemeral scratch — the drive is persistent across sessions of the same company.";

const READ_DESC =
  'Read a file from the company shared drive. Returns up to 256KB by default; pass `max_bytes` to raise (cap 4MB) or `offset` to page.';

const LIST_DESC =
  'List files in the company shared drive. Optional filters: `prefix` (path startsWith), `owner_role`.';

const DELETE_DESC = 'Delete a file from the company shared drive. Returns false if the path was not present.';

const APPEND_DESC =
  'Append text to a file in the company shared drive (creates the file if missing). Useful for shared logs / running notes between agents.';

function requireCompany(ctx: Parameters<CoderTool['handler']>[1]) {
  const company = ctx.companyContext;
  if (!company) throw new Error('shared-drive tools require a company orchestrator context');
  const drive = company.orchestrator.driveStore;
  const scopeKey = drive.resolveScopeKey();
  return {
    drive,
    scopeKey,
    owner: { role: company.agentRole, agentRunId: company.agentRunId ?? null },
  };
}

export const writeSharedFile: CoderTool = {
  name: 'write_shared_file',
  description: WRITE_DESC,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Logical path inside the drive (e.g. "specs/auth.md"). Relative; no "..".' },
      content: { type: 'string', description: 'File content (UTF-8 text). Max 4MB.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const { drive, scopeKey, owner } = requireCompany(ctx);
      const meta = drive.write(scopeKey, String(args.path), String(args.content ?? ''), owner);
      return ok(
        `Wrote ${meta.path} (${meta.sizeBytes} bytes) to shared drive ${scopeKey}.\n` +
        JSON.stringify({ meta }, null, 2),
      );
    } catch (e) {
      return err(`write_shared_file failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const appendSharedFile: CoderTool = {
  name: 'append_shared_file',
  description: APPEND_DESC,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Logical path inside the drive.' },
      content: { type: 'string', description: 'Text to append. Total size after append capped at 4MB.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const { drive, scopeKey, owner } = requireCompany(ctx);
      const meta = drive.append(scopeKey, String(args.path), String(args.content ?? ''), owner);
      return ok(
        `Appended to ${meta.path}; size now ${meta.sizeBytes} bytes.\n` +
        JSON.stringify({ meta }, null, 2),
      );
    } catch (e) {
      return err(`append_shared_file failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const readSharedFile: CoderTool = {
  name: 'read_shared_file',
  description: READ_DESC,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Logical path of the file to read.' },
      offset: { type: 'number', description: 'Byte offset into the file. Default 0.' },
      max_bytes: { type: 'number', description: 'Max bytes to return. Default 262144 (256KB), cap 4194304 (4MB).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const { drive, scopeKey } = requireCompany(ctx);
      const result = drive.read(scopeKey, String(args.path), {
        offset: typeof args.offset === 'number' ? args.offset : undefined,
        maxBytes: typeof args.max_bytes === 'number' ? args.max_bytes : undefined,
      });
      const tail = result.truncated ? '\n[…truncated — use offset+max_bytes to page the rest…]' : '';
      const header = `# ${result.meta.path} (${result.meta.sizeBytes} bytes, mime=${result.meta.mime})\n`;
      return ok(header + result.content + tail);
    } catch (e) {
      return err(`read_shared_file failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const listSharedFiles: CoderTool = {
  name: 'list_shared_files',
  description: LIST_DESC,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      prefix: { type: 'string', description: 'Only return paths starting with this prefix.' },
      owner_role: { type: 'string', description: 'Only return files written by this role.' },
    },
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const { drive, scopeKey } = requireCompany(ctx);
      const files = drive.list(scopeKey, {
        prefix: typeof args.prefix === 'string' ? args.prefix : undefined,
        ownerRole: typeof args.owner_role === 'string' ? args.owner_role : undefined,
      });
      const compact = files.map((f) => ({
        path: f.path,
        size_bytes: f.sizeBytes,
        owner_role: f.ownerRole,
        updated_at: f.updatedAt,
      }));
      return ok(JSON.stringify({ scope: scopeKey, files: compact }, null, 2));
    } catch (e) {
      return err(`list_shared_files failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export const deleteSharedFile: CoderTool = {
  name: 'delete_shared_file',
  description: DELETE_DESC,
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Logical path of the file to delete.' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    try {
      const { drive, scopeKey } = requireCompany(ctx);
      const deleted = drive.delete(scopeKey, String(args.path));
      return ok(deleted ? `Deleted ${String(args.path)}.` : `Path not found: ${String(args.path)}.`);
    } catch (e) {
      return err(`delete_shared_file failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

export function buildSharedDriveTools(): CoderTool[] {
  return [writeSharedFile, appendSharedFile, readSharedFile, listSharedFiles, deleteSharedFile];
}
