import type { CoderTool, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

// Real runners always provide the resolved session cap through ToolContext.
// This is only a conservative fallback for stripped hosts/tests.
const FALLBACK_INLINE_CAP = 10_000;

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
    "VALID ID: copy the exact hexadecimal output_id from that marker. Never invent a placeholder. A dashboard label saying `truncated for transport` is only a UI preview and is not a recovery handle.\n" +
    'PAGINATE: use `offset` + `limit`; for every next page, copy the exact `next offset` printed in the previous footer (the effective page size follows the active session budget).\n' +
    "DON'T: call speculatively — recovery pages consume context. Read only the omitted evidence you actually need.\n" +
    "DON'T: use as a substitute for re-running the original tool with narrower params (offset/limit/glob). Narrower retry is cheaper and teaches the model to ask for less.",
  source: 'native',
  outputPolicy: { mode: 'page', reducer: 'none', recovery: 'cursor' },
  parameters: {
    type: 'object',
    properties: {
      output_id: {
        type: 'string',
        description: 'The output_id embedded in the truncation marker (6-64 hex chars).',
        pattern: '^[a-f0-9]{6,64}$',
      },
      offset: {
        type: 'number',
        description: 'Character offset to start reading from (default: 0).',
      },
      limit: {
        type: 'number',
        description: 'Requested max characters (default: the active session inline budget); always clamped to that budget, including cursor metadata.',
      },
    },
    required: ['output_id'],
    additionalProperties: false,
  },
  handler: async (args, ctx): Promise<ToolResult> => {
    const rawId = String(args.output_id ?? '').trim();
    if (!rawId) return err('output_id cannot be empty');
    if (!/^[a-f0-9]{6,64}$/i.test(rawId)) {
      return err(
        `Invalid output_id '${rawId}'. Copy the exact hexadecimal id from a [truncated: ... output_id=...] marker; never invent a placeholder. A dashboard "truncated for transport" preview is not a get_tool_output handle.`,
      );
    }
    const id = rawId.toLowerCase();
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
    const rawOffset = Number(args.offset ?? 0);
    const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
    // The finalizer applies this same ceiling. Budget the footer BEFORE the
    // slice so a recovery page is never truncated into another output_id.
    const inlineCap = positiveNumber(ctx.toolOutputInlineCap, FALLBACK_INLINE_CAP);
    const requestedLimit = positiveNumber(args.limit, inlineCap);
    return ok(renderOutputPage({ content, id, offset, requestedLimit, inlineCap }));
  },
};

export function renderOutputPage(args: {
  content: string;
  id: string;
  offset: number;
  requestedLimit: number;
  inlineCap: number;
}): string {
  const { content, id } = args;
  const total = content.length;
  let offset = Math.min(total, Math.max(0, Math.floor(args.offset)));
  // String offsets are UTF-16 code units. Normalize a caller-provided cursor
  // that lands between a surrogate pair so a page never starts with an
  // orphaned low surrogate.
  if (
    offset > 0
    && offset < total
    && content.charCodeAt(offset) >= 0xdc00
    && content.charCodeAt(offset) <= 0xdfff
    && content.charCodeAt(offset - 1) >= 0xd800
    && content.charCodeAt(offset - 1) <= 0xdbff
  ) {
    offset -= 1;
  }
  const inlineCap = positiveNumber(args.inlineCap, FALLBACK_INLINE_CAP);
  const requestedLimit = positiveNumber(args.requestedLimit, inlineCap);

  const safeEnd = (candidate: number): number => {
    let end = Math.min(total, Math.max(offset, Math.floor(candidate)));
    if (
      end > offset
      && end < total
      && content.charCodeAt(end - 1) >= 0xd800
      && content.charCodeAt(end - 1) <= 0xdbff
      && content.charCodeAt(end) >= 0xdc00
      && content.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1;
    }
    return end;
  };

  let desiredEnd = safeEnd(Math.min(total, offset + requestedLimit));
  if (desiredEnd === offset && offset < total) {
    const first = content.charCodeAt(offset);
    const codePointWidth = first >= 0xd800 && first <= 0xdbff
      && content.charCodeAt(offset + 1) >= 0xdc00
      && content.charCodeAt(offset + 1) <= 0xdfff
      ? 2
      : 1;
    // A limit of 1 must still make progress over an astral character. Offset
    // remains UTF-16 based for compatibility, so this may exceed the requested
    // limit by one code unit while returning exactly one code point.
    desiredEnd = Math.min(total, offset + codePointWidth);
  }

  const footerFor = (end: number): string => {
    const remaining = total - end;
    const clamped = end - offset < Math.min(requestedLimit, Math.max(0, total - offset));
    return remaining > 0
      ? `\n\n[chars ${offset}–${end} of ${total}; ${remaining} chars remaining${clamped ? '; page limited to inline budget' : ''} — call get_tool_output("${id}", offset=${end}) for next chunk]`
      : `\n\n[chars ${offset}–${end} of ${total}; end of output]`;
  };

  // Start from the requested boundary and only move backwards by the exact
  // overflow. Unlike a fixed-point loop, this cannot oscillate when cursor
  // digit counts or the "limited" suffix change at a boundary.
  let end = desiredEnd;
  let footer = footerFor(end);
  while (end > offset && end - offset + footer.length > inlineCap) {
    const overflow = end - offset + footer.length - inlineCap;
    end = safeEnd(Math.max(offset, end - Math.max(1, overflow)));
    footer = footerFor(end);
  }

  if (end - offset + footer.length > inlineCap) {
    // Synthetic tiny caps use a compact cursor. Recompute it after every end
    // change as its digit width is part of the budget too.
    end = desiredEnd;
    let compactFooter = end < total ? `\n[next=${end}/${total}]` : `\n[end=${total}]`;
    while (end > offset && end - offset + compactFooter.length > inlineCap) {
      const overflow = end - offset + compactFooter.length - inlineCap;
      end = safeEnd(Math.max(offset, end - Math.max(1, overflow)));
      compactFooter = end < total ? `\n[next=${end}/${total}]` : `\n[end=${total}]`;
    }
    if (end === offset && offset < desiredEnd) {
      const oneCodePointEnd = desiredEnd;
      const oneFooter = oneCodePointEnd < total
        ? `\n[next=${oneCodePointEnd}/${total}]`
        : `\n[end=${total}]`;
      if (oneCodePointEnd - offset + oneFooter.length <= inlineCap) {
        end = oneCodePointEnd;
        compactFooter = oneFooter;
      }
    }
    if (end - offset + compactFooter.length > inlineCap) {
      return compactFooter.slice(0, inlineCap);
    }
    return content.slice(offset, end) + compactFooter;
  }
  return content.slice(offset, end) + footer;
}

export const toolOutputTools: CoderTool[] = [getToolOutput];
