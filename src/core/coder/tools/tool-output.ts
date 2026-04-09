import type { CoderTool, ToolResult } from '../core/tool.js';
import { ok, err } from '../core/tool.js';

/**
 * get_tool_output — retrieve the full, untruncated content of a previous
 * tool call whose output was too large to keep inline.
 *
 * When a tool's output exceeds the per-block cap, the runner writes the full
 * content to a side file and injects a marker like:
 *   [truncated: original_size=42000 chars, output_id=abc123; call get_tool_output("abc123") to retrieve]
 * This tool reads that file and returns the content. The agent should ONLY
 * call it when the elided portion is actually needed — pulling the full file
 * back into context obviously burns tokens.
 */
export const getToolOutput: CoderTool = {
  name: 'get_tool_output',
  description:
    'Retrieve the full content of a previously-truncated tool output by its output_id.\n' +
    "USE: when a tool result was truncated (look for `[truncated: ... output_id=XYZ]`) and the elided portion is necessary to proceed.\n" +
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
    return ok(content);
  },
};

export const toolOutputTools: CoderTool[] = [getToolOutput];
