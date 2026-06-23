import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

const DEFAULT_PAGE_SIZE = Number(process.env.CODER_PUSH_TIME_CAP ?? 24_000);

/**
 * get_tool_output — retrieve the full, untruncated content of a previous
 * tool call whose output was too large to keep inline.
 *
 * When a tool's output exceeds the per-block cap, the runner writes the full
 * content to a side file and injects a marker like:
 *   [truncated: original_size=42000 chars, output_id=abc123; call get_tool_output("abc123") to retrieve]
 * This tool reads that file and returns the content. The agent should ONLY
 * call it when the elided portion is actually needed — pulling the full file
 * back into context obviously burns tokens. Use offset/limit to paginate.
 */
export const getToolOutput: CoderTool = {
  name: 'get_tool_output',
  description:
    'Retrieve the full content of a previously-truncated tool output by its output_id.\n' +
    "USE: when a tool result was truncated (look for `[truncated: ... output_id=XYZ]`) and the elided portion is necessary to proceed.\n" +
    "PAGINATE: use `offset` + `limit` to read large outputs in chunks (e.g. offset=24000 for the second page).\n" +
    "DON'T: call speculatively — reading a 40k-char output back into context is expensive. Most truncations are safe to ignore (the head usually contains the signal).\n" +
    "DON'T: use as a substitute for re-running the original tool with narrower params (offset/limit/glob). Narrower retry is cheaper and teaches the model to ask for less.",
  source: 'native',
  parameters: {
    type: 'object',
    properties: {
      output_id: {
        type: 'string',
        description: 'The output_id embedded in the truncation marker (6-64 hex chars).',
      },
      offset: {
        type: 'number',
        description: 'Character offset to start reading from (default: 0).',
      },
      limit: {
        type: 'number',
        description: `Max characters to return (default: ${DEFAULT_PAGE_SIZE}). Reduce to avoid filling context.`,
      },
    },
    required: ['output_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const id = String(args.output_id ?? '').trim();
    if (!id) return err('output_id cannot be empty');
    const store = ctx.toolOutputStore;
    if (!store) {
      return err('Tool output store is not available in this session (likely a subagent or test run).');
    }
    const content = store.get(id);
    if (content === null) {
      return err(
        `No tool output found for id '${id}'. It may have been garbage-collected (default TTL 7 days) or the id is wrong — recheck the truncation marker.`,
      );
    }

    const total = content.length;
    const offset = Math.max(0, Math.floor(Number(args.offset ?? 0)));
    const limit = Math.max(1, Math.floor(Number(args.limit ?? DEFAULT_PAGE_SIZE)));
    const slice = content.slice(offset, offset + limit);
    const end = offset + slice.length;
    const remaining = total - end;

    const footer =
      remaining > 0
        ? `\n\n[chars ${offset}–${end} of ${total}; ${remaining} chars remaining — call get_tool_output("${id}", offset=${end}) for next chunk]`
        : `\n\n[chars ${offset}–${end} of ${total}; end of output]`;

    return ok(slice + footer);
  },
};

export const toolOutputTools: CoderTool[] = [getToolOutput];
