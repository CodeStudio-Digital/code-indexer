import type { ToolContext, ToolResult } from '../core/tool.js';
import { defaultLocalFilesystemPort } from '../ports/filesystem-port.js';
import { pathFor } from './paths.js';

type Handler = (args: Record<string, unknown>, toolCtx: ToolContext) => Promise<ToolResult>;

/**
 * An internal MCP `read_file` (primary or `mcp__<slug>__` prefixed) is a
 * file read for the overwrite rule: after a successful read that is not
 * symbol-only, record the file's current content as seen through the
 * session's own filesystem port — the port write_file will later compare
 * against. A file that port cannot read (for example a host path in a
 * sandbox session) simply stays unknown.
 */
export function withMcpReadKnowledge(
  serverToolName: string,
  projectRootOf: (toolCtx: ToolContext) => string,
  handler: Handler,
): Handler {
  if (serverToolName !== 'read_file') return handler;
  return async (args, toolCtx) => {
    const result = await handler(args, toolCtx);
    const filePath = args.file_path;
    if (result.isError || !toolCtx.fileKnowledge || typeof filePath !== 'string' || !filePath || args.symbol != null) {
      return result;
    }
    const root = projectRootOf(toolCtx);
    const abs = pathFor(root).resolve(root, filePath);
    try {
      toolCtx.fileKnowledge.recordContent(abs, await (toolCtx.ports?.fs ?? defaultLocalFilesystemPort()).readFile(abs));
    } catch {
      // Unreadable through the session port: the file stays unknown.
    }
    return result;
  };
}
