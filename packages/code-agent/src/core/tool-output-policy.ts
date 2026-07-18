import type { CoderTool, ToolOutputPolicy } from './tool.js';

export interface ResolvedToolOutputPolicy {
  mode: NonNullable<ToolOutputPolicy['mode']>;
  reducer: 'smart' | 'none';
  recovery: NonNullable<ToolOutputPolicy['recovery']>;
  maxInlineChars?: number;
  preserveOnError: boolean;
  /** Final emergency cut must keep a contiguous prefix for exact pages/ranges. */
  capStrategy: 'head_tail' | 'contiguous';
}

const AUTHORITATIVE_TOOLS = new Set([
  'read_plan',
  'get_skill_content',
  'invoke_skill',
  'app_get_plan',
  // Compatibility with App Studio v5 sessions/transcripts.
  'app_get_workflow',
  'app_get_build_plan',
  'app_get_stage_briefing',
  'app_get_context',
  'app_get_spec',
]);

const PAGE_TOOLS = new Set(['get_tool_output']);
const LINE_RANGE_TOOLS = new Set(['read_file', 'mcp__read_file']);
const ROW_TOOLS = new Set(['db_query', 'db_command']);
const LOG_TOOLS = new Set(['run_command', 'exec_command', 'code_exec']);
const DIFF_TOOLS = new Set(['git_diff']);
const SEARCH_TOOLS = new Set([
  'grep_code',
  'mcp__grep_code',
  'glob',
  'web_search',
  'rag_search_docs',
]);

function inferredPolicy(toolName: string): ToolOutputPolicy {
  if (AUTHORITATIVE_TOOLS.has(toolName) || toolName.endsWith('__rag_read_doc')) {
    return { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true };
  }
  if (PAGE_TOOLS.has(toolName)) {
    return { mode: 'page', reducer: 'none', recovery: 'cursor' };
  }
  if (LINE_RANGE_TOOLS.has(toolName) || toolName.endsWith('__read_file')) {
    return { mode: 'line_range', reducer: 'none', recovery: 'cursor' };
  }
  if (ROW_TOOLS.has(toolName)) {
    return { mode: 'rows', reducer: 'smart', recovery: 'output_store', preserveOnError: true };
  }
  if (LOG_TOOLS.has(toolName)) {
    return { mode: 'logs', reducer: 'smart', recovery: 'output_store', preserveOnError: true };
  }
  if (DIFF_TOOLS.has(toolName)) {
    return { mode: 'diff', reducer: 'smart', recovery: 'output_store' };
  }
  if (SEARCH_TOOLS.has(toolName) || /(?:^|__)search(?:_|$)/.test(toolName)) {
    return { mode: 'search', reducer: 'smart', recovery: 'rerun' };
  }
  return { mode: 'generic', reducer: 'smart', recovery: 'output_store', preserveOnError: true };
}

export function resolveToolOutputPolicy(
  toolName: string,
  declared?: ToolOutputPolicy | null,
): ResolvedToolOutputPolicy {
  const value = declared ?? inferredPolicy(toolName);
  const mode = value.mode ?? 'generic';
  const contiguous = mode === 'page' || mode === 'line_range' || mode === 'rows' || mode === 'authoritative';
  const reducer = value.reducer ?? (mode === 'page' || mode === 'line_range' || mode === 'authoritative' ? 'none' : 'smart');
  const recovery = value.recovery ?? (mode === 'page' || mode === 'line_range' || mode === 'rows' ? 'cursor' : 'output_store');
  const rawMax = value.maxInlineChars;
  const maxInlineChars = typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
    ? Math.floor(rawMax)
    : undefined;
  return {
    mode,
    reducer,
    recovery,
    ...(maxInlineChars ? { maxInlineChars } : {}),
    preserveOnError: value.preserveOnError ?? (mode === 'logs' || mode === 'authoritative'),
    capStrategy: contiguous ? 'contiguous' : 'head_tail',
  };
}

export function resolveRegisteredToolOutputPolicy(
  toolName: string,
  tool?: Pick<CoderTool, 'outputPolicy'>,
  forceAuthoritative = false,
): ResolvedToolOutputPolicy {
  const policy = resolveToolOutputPolicy(toolName, tool?.outputPolicy);
  if (!forceAuthoritative || policy.mode === 'authoritative') return policy;
  return {
    ...policy,
    mode: 'authoritative',
    reducer: 'none',
    recovery: 'output_store',
    preserveOnError: true,
    capStrategy: 'contiguous',
  };
}
