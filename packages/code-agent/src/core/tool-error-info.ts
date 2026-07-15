import type { ToolErrorInfo } from '@mcp/code-agent/core/tool.js';

const NOT_FOUND = /\bnot found\b|ENOENT|no such file or directory|does not exist/i;
const INVALID_INPUT = /^Invalid |invalid arguments?|missing required|required (argument|parameter|field)|must be an? |expected .+ got /i;
const CONFLICT = /already exists|EEXIST|conflict|duplicate/i;
const PERMISSION = /EACCES|EPERM|permission denied|scope .* required|not allowed|outside (the )?project root/i;
const TIMEOUT = /ETIMEDOUT|timed? ?out/i;
const CANCELLED = /cancelled|canceled|aborted/i;
const NETWORK = /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|fetch failed|network error|socket hang up/i;

/**
 * Best-effort compatibility classifier for tools that only return prose.
 * Explicit `ToolResult.error` metadata always wins at the call site; this
 * keeps native, MCP and third-party tools useful while they migrate.
 */
export function inferToolErrorInfo(toolName: string, content: string): ToolErrorInfo {
  if (toolName.endsWith('get_symbol_body') && NOT_FOUND.test(content)) {
    return {
      code: 'SYMBOL_NOT_FOUND',
      kind: 'not_found',
      retryable: false,
      suggestedAction: 'Use get_file_skeleton or search to verify the symbol name before retrying.',
    };
  }
  if (content.startsWith('Unknown tool:')) {
    return {
      code: 'UNKNOWN_TOOL',
      kind: 'invalid_input',
      retryable: false,
      suggestedAction: 'Use list_tools, tool_schema, or find_tools to discover the exact tool name.',
    };
  }
  if (TIMEOUT.test(content)) {
    return {
      code: 'TOOL_TIMEOUT',
      kind: 'timeout',
      retryable: true,
      suggestedAction: 'Check whether the operation is still running, then retry only if it is safe.',
    };
  }
  if (CANCELLED.test(content)) {
    return { code: 'TOOL_CANCELLED', kind: 'cancelled', retryable: true };
  }
  if (PERMISSION.test(content)) {
    return {
      code: 'PERMISSION_DENIED',
      kind: 'permission',
      retryable: false,
      suggestedAction: 'Resolve the permission, scope, or sandbox restriction before retrying.',
    };
  }
  if (CONFLICT.test(content)) {
    return {
      code: 'TOOL_CONFLICT',
      kind: 'conflict',
      retryable: false,
      suggestedAction: 'Inspect the existing state and choose an update or alternate operation.',
    };
  }
  if (INVALID_INPUT.test(content)) {
    return {
      code: 'INVALID_ARGUMENTS',
      kind: 'invalid_input',
      retryable: false,
      suggestedAction: 'Inspect the tool schema and correct the arguments before retrying.',
    };
  }
  if (NETWORK.test(content)) {
    return {
      code: 'NETWORK_ERROR',
      kind: 'network',
      retryable: true,
      suggestedAction: 'Verify connectivity and service availability before retrying.',
    };
  }
  if (NOT_FOUND.test(content)) {
    return {
      code: 'RESOURCE_NOT_FOUND',
      kind: 'not_found',
      retryable: false,
      suggestedAction: 'Verify the requested name or path before retrying.',
    };
  }
  return { code: 'TOOL_ERROR', kind: 'tool_error', retryable: false };
}
