import type { RuntimePolicyLayerV1, RuntimePolicyPatchV1 } from '@mcp/agent-runtime-contracts';

export interface LegacyRuntimePolicyIssue {
  key: string;
  reason: 'invalid_positive_integer' | 'invalid_non_negative_integer' | 'invalid_boolean' | 'invalid_profile';
}

export interface LegacyRuntimePolicyLayerResult {
  layer?: RuntimePolicyLayerV1;
  issues: readonly LegacyRuntimePolicyIssue[];
}

const POSITIVE_INTEGER_PATHS = Object.freeze({
  CODER_PUSH_TIME_CAP: 'toolResultChars',
  CODER_SUBAGENT_PUSH_TIME_CAP: 'subagentToolResultChars',
  CODER_UNRESTRICTED_PUSH_TIME_CAP: 'unrestrictedToolResultChars',
  CODER_UNRESTRICTED_SUBAGENT_PUSH_TIME_CAP: 'unrestrictedSubagentToolResultChars',
  CODER_TURN_BUDGET_CHARS: 'turnBudgetChars',
  CODER_TOOL_MISUSE_INTERVENTION_COOLDOWN: 'interventionCooldownTurns',
} as const);

const MIGRATED_KEYS = Object.freeze([
  ...Object.keys(POSITIVE_INTEGER_PATHS),
  'CODER_TRANSIENT_RETRY_MAX_PER_TURN',
  'CODER_RECOVERY_TRANSIENT_MAX',
  'CODER_STREAM_HEARTBEAT_MS',
  'CODER_PROFILE',
  'CODER_TOOL_CAP_DEFAULT',
  'CODER_PREFLIGHT_VISIBLE_CAP',
  'CODER_DISABLED_MCP_TOOLS',
  'CODER_DISABLE_SUBAGENTS',
  'CODER_PARALLEL_AGENT_MAX',
  'CODER_WORKER_HEAP_MB',
  'CODER_WORKER_TTL_MS',
  'CODER_WORKER_POST_RUN_LINGER_MS',
]);

export const LEGACY_RUNTIME_POLICY_ENV_KEYS = MIGRATED_KEYS;

export function legacyRuntimePolicyLayerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: { revision?: string; strict?: boolean } = {},
): LegacyRuntimePolicyLayerResult {
  const context: Record<string, number> = {};
  const provider: Record<string, number> = {};
  const capabilities: Record<string, unknown> = {};
  const subagents: Record<string, number | boolean> = {};
  const host: Record<string, number> = {};
  const issues: LegacyRuntimePolicyIssue[] = [];

  const positiveInteger = (
    key: string,
    target: Record<string, number>,
    field: string,
    options: { allowZero?: boolean } = {},
  ): void => {
    const raw = env[key];
    if (raw === undefined || raw === '') return;
    const parsed = Number(raw);
    const valid = Number.isSafeInteger(parsed) && (options.allowZero ? parsed >= 0 : parsed > 0);
    if (!valid) {
      issues.push({
        key,
        reason: options.allowZero ? 'invalid_non_negative_integer' : 'invalid_positive_integer',
      });
      return;
    }
    target[field] = parsed;
  };

  for (const [key, field] of Object.entries(POSITIVE_INTEGER_PATHS)) {
    positiveInteger(key, context, field);
  }
  positiveInteger('CODER_TRANSIENT_RETRY_MAX_PER_TURN', provider, 'transientRetriesPerTurn', { allowZero: true });
  positiveInteger('CODER_RECOVERY_TRANSIENT_MAX', provider, 'transientRetriesPerRun', { allowZero: true });
  positiveInteger('CODER_STREAM_HEARTBEAT_MS', provider, 'streamHeartbeatMs');
  positiveInteger('CODER_PARALLEL_AGENT_MAX', subagents as Record<string, number>, 'maxParallel');
  positiveInteger('CODER_WORKER_HEAP_MB', host, 'workerHeapMb');
  positiveInteger('CODER_WORKER_TTL_MS', host, 'workerIdleTtlMs');
  positiveInteger('CODER_WORKER_POST_RUN_LINGER_MS', host, 'workerPostRunLingerMs', { allowZero: true });

  const profile = env.CODER_PROFILE;
  if (profile) {
    if (['auto', 'bootstrap', 'navigate', 'full'].includes(profile)) capabilities.profile = profile;
    else issues.push({ key: 'CODER_PROFILE', reason: 'invalid_profile' });
  }

  const generalCap = env.CODER_TOOL_CAP_DEFAULT;
  const preflightCap = env.CODER_PREFLIGHT_VISIBLE_CAP;
  if (generalCap && preflightCap && generalCap !== preflightCap) {
    issues.push({ key: 'CODER_TOOL_CAP_DEFAULT,CODER_PREFLIGHT_VISIBLE_CAP', reason: 'invalid_positive_integer' });
  } else {
    positiveInteger(
      preflightCap ? 'CODER_PREFLIGHT_VISIBLE_CAP' : 'CODER_TOOL_CAP_DEFAULT',
      capabilities as Record<string, number>,
      'visibleToolCap',
    );
  }

  if (env.CODER_DISABLED_MCP_TOOLS !== undefined) {
    capabilities.disabledCapabilityNames = [...new Set(
      env.CODER_DISABLED_MCP_TOOLS.split(',').map((item) => item.trim()).filter(Boolean),
    )].sort();
  }

  const disabledSubagents = env.CODER_DISABLE_SUBAGENTS;
  if (disabledSubagents !== undefined && disabledSubagents !== '') {
    if (disabledSubagents === '0' || disabledSubagents === '1') {
      subagents.enabled = disabledSubagents !== '1';
    } else {
      issues.push({ key: 'CODER_DISABLE_SUBAGENTS', reason: 'invalid_boolean' });
    }
  }

  if (options.strict && issues.length > 0) {
    throw new Error(`invalid legacy runtime policy env: ${issues.map((item) => item.key).join(', ')}`);
  }
  const values: RuntimePolicyPatchV1 = {
    ...(Object.keys(context).length > 0 ? { context } : {}),
    ...(Object.keys(provider).length > 0 ? { provider } : {}),
    ...(Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(Object.keys(subagents).length > 0 ? { subagents } : {}),
    ...(Object.keys(host).length > 0 ? { host } : {}),
  };
  return {
    layer: Object.keys(values).length > 0
      ? { revision: options.revision ?? 'legacy-process-env', values }
      : undefined,
    issues,
  };
}
