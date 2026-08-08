export type RuntimeEnvDisposition =
  | 'DELETE_DEAD'
  | 'BAKE_ON'
  | 'BAKE_OFF'
  | 'TYPED_POLICY'
  | 'CODE_CONSTANT'
  | 'BOOTSTRAP_ENV'
  | 'ROLLOUT_TEMP'
  | 'MOVE_DOMAIN';

export interface RuntimeEnvClassification {
  disposition: RuntimeEnvDisposition;
  target: string;
  owner: string;
  migrationPhase: string;
  deletionGate: string;
  rule: string;
}

const DEAD = new Set([
  'CODER_MAX_AUTO_CONTINUES', 'CODER_PROFILE_AUTO', 'CODER_BT_ENABLED', 'CODER_LEGACY_RUNNER',
  'MCP_PIPELINES_CONTEXT_RELEVANCE', 'MCP_PIPELINES_TOOL_SELECTION',
  'MCP_PIPELINES_TOOL_SELECTION_APPLY', 'MCP_PIPELINES_TOOL_SELECTION_K',
  'MCP_PIPELINES_SUB_AGENT_CACHE', 'MCP_PIPELINES_HOT_CACHE',
  'MCP_PIPELINES_INDEXER_SEARCH_V2', 'MCP_PIPELINES_POLICY_HARD_BLOCK',
  'MCP_PIPELINES_POLICY_HARD_BLOCK_MODE', 'MCP_PIPELINES_QUALITY_CLASSIFIERS',
  'MCP_PIPELINES_TODO_PRIORITY', 'MCP_PIPELINES_RECENT_FILES_SOURCE',
  'MCP_SHADOW_TOOL_SELECTION_RATE', 'MCP_QUALITY_NUDGE_WAIT_TIMEOUT_MS',
  'MCP_QUALITY_WATCHDOG_ENABLED',
]);

const BAKE_ON = new Set([
  'CODER_AGENT_LOOP_V2', 'CODER_NEW_COMPACTION', 'CODER_COMPACT_PRECOMPUTE',
  'CODER_CONVERSATION_CHAPTERS', 'CODER_ROLLING_REDUCER', 'CODER_STICKY_PROFILE',
  'CODER_FAILURE_CLASSIFICATION', 'CODER_READ_AUTO_DOWNGRADE', 'CODER_READ_COVERAGE_DISABLE',
  'CODER_NESTED_GUARDS_DISABLE', 'CODER_NESTED_TELEMETRY_DISABLE',
  'CODER_PRIORITY_TRIM_DISABLE', 'CODER_TOOL_ARG_ALIASES_DISABLE', 'CODER_TOOL_PIN_DISABLE',
  'CODER_TASKS_DISABLE_SKIP_STALE', 'CODER_RETRIEVAL_GUARD', 'CODER_HOOK_BUS_V1',
  'CODER_STRUCTURED_SUMMARY', 'CODER_SUMMARIZER_ENABLE',
]);

const BOOTSTRAP = new Set([
  'CODER_BT_DEBUG', 'CODER_PROVIDER_DEBUG', 'CODER_PROMPTS_WATCH', 'CODER_GITHUB_TOKEN',
]);

function result(
  disposition: RuntimeEnvDisposition,
  target: string,
  rule: string,
  owner = 'code-runtime',
  phase = 'P4-P5',
): RuntimeEnvClassification {
  return {
    disposition,
    target,
    owner,
    migrationPhase: phase,
    deletionGate: disposition === 'ROLLOUT_TEMP'
      ? 'owner, expiry, promotion metric and rollback receipt required'
      : 'zero production consumers plus parity/corpus gate',
    rule,
  };
}

export function classifyRuntimeEnv(key: string): RuntimeEnvClassification | null {
  if (!(key.startsWith('CODER_') || key.startsWith('MCP_PIPELINES_'))) return null;
  if (DEAD.has(key)) return result('DELETE_DEAD', 'remove consumer/catalog/row/docs', 'dead-exact', 'code-runtime', 'P0-P1');
  if (key === 'MCP_PIPELINES_GRAPH_EXPANSION') {
    return result('MOVE_DOMAIN', 'IndexerSearchPolicy.graphExpansion', 'move-indexer', 'indexer', 'P2');
  }
  if (/_SHADOW$|_ENFORCE$|_ROLLOUT_PERCENT$/.test(key)) {
    return result('ROLLOUT_TEMP', 'rollout manifest with expiry', 'rollout-suffix', 'runtime-migration', 'P3-P5');
  }
  if (BOOTSTRAP.has(key)) return result('BOOTSTRAP_ENV', 'bootstrap allowlist', 'bootstrap-exact', 'host-bootstrap', 'P2');
  if (key === 'CODER_SELF_REVIEW' || key === 'CODER_AGENTLESS_MODE') {
    return result('BAKE_OFF', 'remove automatic/legacy branch', 'bake-off-exact', 'code-runtime', 'P1-P2');
  }
  if (BAKE_ON.has(key)) return result('BAKE_ON', 'mandatory product invariant', 'bake-on-exact', 'code-runtime', 'P1-P2');

  if (/^CODER_(?:MODEL|FALLBACK|STREAM|RECOVERY|TRANSIENT_RETRY)/.test(key)) {
    return result('TYPED_POLICY', 'RuntimePolicy.provider', 'provider-family');
  }
  if (/^CODER_(?:COMPACT|AUTOCOMPACT|CONTEXT|PRUNE|PROTECT|PUSH|TURN|SHORT_WINDOW|SUMMARIZER_BUDGET|REPOMAP|POSTTURN|PREEMIT)/.test(key)) {
    return result('TYPED_POLICY', 'RuntimePolicy.context', 'context-family');
  }
  if (/^CODER_(?:PROFILE|DISABLED_MCP|DYNAMIC_TOOL|FIND_TOOLS|GREP|MCP_PATHOLOGICAL|PREFLIGHT|READ_FILE|SKILLS|STRICT_TIERS|TERSE_TOOLS|TOOL_CAP)/.test(key)) {
    return result('TYPED_POLICY', 'RuntimePolicy.capabilities', 'capability-family');
  }
  if (/^CODER_(?:SUBAGENT|SPAWN|PARALLEL|DISABLE_SUBAGENTS)/.test(key)) {
    return result('TYPED_POLICY', 'RuntimePolicy.subagents', 'subagent-family');
  }
  if (/^CODER_(?:CODE_EXEC|UNRESTRICTED|WORKER|WATCHDOG)/.test(key)) {
    return result('TYPED_POLICY', 'RuntimePolicy.host', 'host-family', 'host-runtime');
  }
  if (/^CODER_(?:TASK|BACKGROUND|RESUME|WORKFLOW|IMPLEMENT|REVIEW|GOAL_VERIFY|ATTACH_REPLAY|ORCHESTRATION_LEASE)/.test(key)) {
    return result('TYPED_POLICY', 'RuntimePolicy.execution', 'execution-family');
  }
  if (/^CODER_COMPANY|^CODER_SUBORDINATE/.test(key)) {
    return result('MOVE_DOMAIN', 'CompanyRuntimePolicy', 'company-family', 'company-runtime', 'P2');
  }
  if (/^CODER_MEMORY/.test(key)) {
    return result('MOVE_DOMAIN', 'MemoryRetrievalPolicy', 'memory-family', 'memory-runtime', 'P2');
  }
  if (/^CODER_WEB/.test(key)) return result('TYPED_POLICY', 'RuntimePolicy.capabilities.http', 'web-family');

  return result('CODE_CONSTANT', 'versioned internal constant', 'code-runtime-remainder', 'code-runtime', 'P2');
}
