export const CLAUDE_CODE_PACKAGE_VERSION = '2.1.219';
export const CLAUDE_CODE_BASE_URL =
  process.env.CLAUDE_CODE_API_BASE_URL ?? 'https://api.anthropic.com';
export const CLAUDE_CODE_VERSION =
  process.env.CLAUDE_CODE_VERSION ?? CLAUDE_CODE_PACKAGE_VERSION;
export const CLAUDE_CODE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_CODE_CLI_BETA = 'claude-code-20250219';
export const CLAUDE_CODE_INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
export const CLAUDE_CODE_CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
export const CLAUDE_CODE_PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05';
export const CLAUDE_CODE_EXTENDED_CACHE_TTL_BETA = 'extended-cache-ttl-2025-04-11';
export const CLAUDE_CODE_CONTEXT_1M_BETA = 'context-1m-2025-08-07';
export const CLAUDE_CODE_MID_CONVERSATION_SYSTEM_BETA =
  'mid-conversation-system-2026-04-07';
export const CLAUDE_CODE_ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_CODE_SMALL_FAST_MODEL =
  process.env.ANTHROPIC_SMALL_FAST_MODEL ?? 'claude-haiku-4-5-20251001';
export const CLAUDE_CODE_DEFAULT_SONNET_MODEL =
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-5';
export const CLAUDE_CODE_DEFAULT_OPUS_MODEL =
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? 'claude-opus-5';
export const CLAUDE_CODE_DEFAULT_FABLE_MODEL =
  process.env.ANTHROPIC_DEFAULT_FABLE_MODEL ?? 'claude-fable-5';

export interface ClaudeCodeProfileInfo {
  subscriptionType: 'max' | 'pro' | 'enterprise' | 'team' | null;
  rateLimitTier: string | null;
  seatTier?: string | null;
  hasExtraUsageEnabled?: boolean | null;
  billingType?: string | null;
}

export type ClaudeCodeModelAlias =
  | 'default'
  | 'sonnet'
  | 'sonnet[1m]'
  | 'haiku'
  | 'fable'
  | 'opus'
  | 'opus[1m]'
  | string;

export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ClaudeCodeAccountInfo {
  subscriptionType?: string | null;
  rateLimitTier?: string | null;
  billingType?: string | null;
}

export interface ResolveClaudeCodeModelOptions {
  includeOAuth?: boolean;
  thinking?: boolean;
  thinkingDisplay?: string | null;
  effort?: ClaudeCodeEffort | 'auto' | null;
  promptCacheTtl?: '5m' | '1h';
  hasTools?: boolean;
}

export interface ClaudeCodeResolvedModel {
  alias: string;
  requestedModel: string;
  apiModel: string;
  displayModel: string;
  displayName: string;
  maxTokens: number;
  betas: string[];
  thinking?: Record<string, unknown>;
  outputConfig?: Record<string, unknown>;
  effort: ClaudeCodeEffort | null;
  supportsEffort: boolean;
  supportsAdaptiveThinking: boolean;
  isOneMillionContext: boolean;
}

export function getClaudeCodeUserAgent(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : '';
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : '';
  const workload = process.env.CLAUDE_CODE_WORKLOAD
    ? `, workload/${process.env.CLAUDE_CODE_WORKLOAD}`
    : '';
  const suffix = `${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workload}`;
  return process.env.CLAUDE_CODE_USER_AGENT ?? `claude-cli/${CLAUDE_CODE_VERSION} (external, ${suffix})`;
}

export const CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_BILLING_SOURCE = 'cli';

export function buildClaudeCodeBillingHeaderText(): string {
  const attribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER?.trim().toLowerCase();
  if (
    attribution === 'false' ||
    attribution === 'off' ||
    attribution === '0' ||
    isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_ATTRIBUTION_HEADER)
  ) return '';
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown';
  const workload = process.env.CLAUDE_CODE_WORKLOAD
    ? ` cc_workload=${process.env.CLAUDE_CODE_WORKLOAD};`
    : '';
  return (
    `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${CLAUDE_CODE_BILLING_SOURCE};` +
    ` cc_entrypoint=${entrypoint}; cch=00000;${workload}`
  );
}

export function getClaudeCodeSystemPrefixBlocks(): Array<{ type: 'text'; text: string }> {
  const blocks: Array<{ type: 'text'; text: string }> = [];
  const billing = buildClaudeCodeBillingHeaderText();
  if (billing) blocks.push({ type: 'text', text: billing });
  blocks.push({ type: 'text', text: CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT });
  return blocks;
}

export function claudeCodeAuthHeaders(input: {
  apiKey?: string | null;
  authToken?: string | null;
  userAgent?: string;
}): Record<string, string> {
  const userAgent = input.userAgent ?? getClaudeCodeUserAgent();
  if (input.authToken) {
    return {
      Authorization: `Bearer ${input.authToken}`,
      'anthropic-beta': CLAUDE_CODE_OAUTH_BETA,
      'User-Agent': userAgent,
    };
  }
  return {
    'x-api-key': input.apiKey ?? '',
    'User-Agent': userAgent,
  };
}

export function buildClaudeCodeModelsUrl(baseURL = CLAUDE_CODE_BASE_URL): string {
  return `${baseURL.replace(/\/$/, '')}/v1/models?beta=true`;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function stripClaudeCodeContextSuffix(model: string): string {
  return model.replace(/\[(1|2)m\]$/i, '');
}

function isClaudeCodeOneMillionContext(model: string): boolean {
  return /\[1m\]$/i.test(model.trim());
}

export function normalizeClaudeCodeModelAlias(model: string | null | undefined): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return 'default';
  const lower = trimmed.toLowerCase();
  switch (lower) {
    case 'default':
    case 'sonnet':
    case 'sonnet[1m]':
    case 'haiku':
    case 'fable':
    case 'opus':
    case 'opus[1m]':
    case 'opus-4-8':
    case 'opus-4-8[1m]':
    case 'sonnet-4-6':
    case 'sonnet-4-6[1m]':
    case 'opus-4-7':
    case 'opus-4-7[1m]':
    case 'opus-4-6':
    case 'opus-4-6[1m]':
      return lower;
    default:
      return trimmed;
  }
}

export function isClaudeCodeMaxDefaultAccount(
  accountInfo?: ClaudeCodeAccountInfo | null,
): boolean {
  const subscriptionType = accountInfo?.subscriptionType ?? null;
  const rateLimitTier = accountInfo?.rateLimitTier ?? null;
  const billingType = accountInfo?.billingType ?? null;
  return (
    subscriptionType === 'max' ||
    (subscriptionType === 'team' && rateLimitTier === 'default_claude_max_5x') ||
    (subscriptionType === 'enterprise' && billingType === 'enterprise_usage_based')
  );
}

export function resolveClaudeCodeRequestedModel(
  model: string | null | undefined,
  accountInfo?: ClaudeCodeAccountInfo | null,
): string {
  const alias = normalizeClaudeCodeModelAlias(model);
  // Read operator overrides after settings bootstrap, including later saves.
  const CLAUDE_CODE_DEFAULT_OPUS_MODEL = process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? 'claude-opus-5';
  const CLAUDE_CODE_DEFAULT_SONNET_MODEL = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-5';
  const CLAUDE_CODE_SMALL_FAST_MODEL = process.env.ANTHROPIC_SMALL_FAST_MODEL ?? 'claude-haiku-4-5-20251001';
  switch (alias.toLowerCase()) {
    case 'default':
      return isClaudeCodeMaxDefaultAccount(accountInfo)
        ? `${CLAUDE_CODE_DEFAULT_OPUS_MODEL}[1m]`
        : CLAUDE_CODE_DEFAULT_SONNET_MODEL;
    case 'sonnet':
      return CLAUDE_CODE_DEFAULT_SONNET_MODEL;
    case 'sonnet[1m]':
      return `${CLAUDE_CODE_DEFAULT_SONNET_MODEL}[1m]`;
    case 'haiku':
      return CLAUDE_CODE_SMALL_FAST_MODEL;
    case 'fable':
      return CLAUDE_CODE_DEFAULT_FABLE_MODEL;
    case 'opus':
      return CLAUDE_CODE_DEFAULT_OPUS_MODEL;
    case 'opus[1m]':
      return `${CLAUDE_CODE_DEFAULT_OPUS_MODEL}[1m]`;
    case 'opus-4-8':
      return 'claude-opus-4-8';
    case 'opus-4-8[1m]':
      return 'claude-opus-4-8[1m]';
    case 'sonnet-4-6':
      return 'claude-sonnet-4-6';
    case 'sonnet-4-6[1m]':
      return 'claude-sonnet-4-6[1m]';
    case 'opus-4-7':
      return 'claude-opus-4-7';
    case 'opus-4-7[1m]':
      return 'claude-opus-4-7[1m]';
    case 'opus-4-6':
      return 'claude-opus-4-6';
    case 'opus-4-6[1m]':
      return 'claude-opus-4-6[1m]';
    default:
      return alias;
  }
}

function claudeCodeModelFamily(model: string): string {
  return stripClaudeCodeContextSuffix(model).toLowerCase();
}

function isClaudeCodeNativeOneMillionModel(model: string): boolean {
  const cleanModel = claudeCodeModelFamily(model);
  return (
    cleanModel.includes('claude-opus-5') ||
    cleanModel.includes('claude-opus-4-8') ||
    cleanModel.includes('claude-opus-4-7') ||
    cleanModel.includes('claude-sonnet-5') ||
    cleanModel.includes('claude-fable-5') ||
    cleanModel.includes('claude-mythos-5')
  );
}

export function supportsClaudeCodeAdaptiveThinking(model: string): boolean {
  const cleanModel = claudeCodeModelFamily(model);
  return (
    cleanModel.includes('claude-opus-5') ||
    cleanModel.includes('claude-opus-4-8') ||
    cleanModel.includes('claude-opus-4-7') ||
    cleanModel.includes('claude-opus-4-6') ||
    cleanModel.includes('claude-sonnet-4-6') ||
    cleanModel.includes('claude-sonnet-5') ||
    cleanModel.includes('claude-fable-5') ||
    cleanModel.includes('claude-mythos-5')
  );
}

export function supportsClaudeCodeEffort(model: string): boolean {
  return supportsClaudeCodeAdaptiveThinking(model);
}

function parseClaudeCodeEffort(value: string | null | undefined): ClaudeCodeEffort | null {
  switch ((value ?? '').trim().toLowerCase()) {
    case 'low':
    case 'medium':
    case 'high':
    case 'xhigh':
    case 'max':
      return value!.trim().toLowerCase() as ClaudeCodeEffort;
    default:
      return null;
  }
}

function getClaudeCodeEffort(
  model: string,
  requestedEffort?: ClaudeCodeEffort | 'auto' | null,
): ClaudeCodeEffort | null {
  if (!supportsClaudeCodeEffort(model)) return null;
  const cleanModel = claudeCodeModelFamily(model);
  const configured =
    requestedEffort === 'auto' ? null : requestedEffort ?? parseClaudeCodeEffort(process.env.CLAUDE_CODE_EFFORT_LEVEL);
  const effort = configured ?? (cleanModel.includes('claude-opus-4-7') ? 'xhigh' : 'high');
  const supportsXHigh =
    cleanModel.includes('claude-opus-5') ||
    cleanModel.includes('claude-opus-4-8') ||
    cleanModel.includes('claude-opus-4-7') ||
    cleanModel.includes('claude-sonnet-5') ||
    cleanModel.includes('claude-fable-5') ||
    cleanModel.includes('claude-mythos-5');
  if (effort === 'xhigh' && !supportsXHigh) return 'high';
  return effort;
}

export function getClaudeCodeDefaultMaxTokens(model: string): number {
  const cleanModel = claudeCodeModelFamily(model);
  const usesLargeOutput =
    cleanModel.includes('claude-opus-5') ||
    cleanModel.includes('claude-opus-4-8') ||
    cleanModel.includes('claude-opus-4-7') ||
    cleanModel.includes('claude-opus-4-6') ||
    cleanModel.includes('claude-sonnet-5') ||
    cleanModel.includes('claude-fable-5') ||
    cleanModel.includes('claude-mythos-5');
  const defaults = usesLargeOutput
    ? { value: 64_000, upper: 128_000 }
    : cleanModel.includes('claude-haiku-4-5')
      ? { value: 32_000, upper: 64_000 }
      : cleanModel.includes('claude-sonnet-4-6')
        ? { value: 32_000, upper: 128_000 }
        : { value: 32_000, upper: 128_000 };
  const override = Number(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? '');
  if (Number.isFinite(override) && override > 0) {
    return Math.min(Math.floor(override), defaults.upper);
  }
  return defaults.value;
}

function getClaudeCodeDisplayName(alias: string, requestedModel: string): string {
  const lowerAlias = alias.toLowerCase();
  const cleanModel = claudeCodeModelFamily(requestedModel);
  if (lowerAlias === 'default' && cleanModel.includes('claude-opus-5')) {
    return 'Opus 5 (automatic, 1M context)';
  }
  if (lowerAlias === 'default') {
    return 'Sonnet 5 (automatic)';
  }
  const oneMillion = isClaudeCodeOneMillionContext(requestedModel);
  if (lowerAlias === 'sonnet[1m]' || (oneMillion && cleanModel.includes('claude-sonnet-5'))) {
    return 'Sonnet 5 (1M context)';
  }
  if (lowerAlias === 'opus[1m]' || (oneMillion && cleanModel.includes('claude-opus-5'))) {
    return 'Opus 5 (1M context)';
  }
  if (
    lowerAlias === 'opus-4-8[1m]' ||
    (oneMillion && cleanModel.includes('claude-opus-4-8'))
  ) {
    return 'Opus 4.8 (1M context)';
  }
  if (lowerAlias === 'opus-4-6[1m]' || (oneMillion && cleanModel.includes('claude-opus-4-6'))) {
    return 'Opus 4.6 (1M context)';
  }
  if (cleanModel.includes('claude-haiku-4-5')) return 'Haiku 4.5';
  if (cleanModel.includes('claude-fable-5')) return 'Fable 5';
  if (cleanModel.includes('claude-opus-5')) return 'Opus 5';
  if (cleanModel.includes('claude-opus-4-8')) return 'Opus 4.8';
  if (cleanModel.includes('claude-opus-4-7')) return 'Opus 4.7';
  if (cleanModel.includes('claude-opus-4-6')) return 'Opus 4.6';
  if (cleanModel.includes('claude-opus-4-5')) return 'Opus 4.5';
  if (cleanModel.includes('claude-sonnet-5')) return 'Sonnet 5';
  if (cleanModel.includes('claude-sonnet-4-6')) return 'Sonnet 4.6';
  if (cleanModel.includes('claude-sonnet-4-5')) return 'Sonnet 4.5';
  return requestedModel;
}

export function getClaudeCodeBetasForModel(
  model: string,
  includeOAuth = true,
  opts?: {
    hasEffort?: boolean;
    thinkingDisplay?: string | null;
    hasTools?: boolean;
    promptCacheTtl?: '5m' | '1h';
  },
): string[] {
  const cleanModel = claudeCodeModelFamily(model);
  const isHaiku = cleanModel.includes('haiku');
  const isClaude3 = cleanModel.includes('claude-3-');
  const supportsInterleaved = !isClaude3 && !cleanModel.includes('claude-haiku-4-5');
  const experimentalBetasDisabled = isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS);
  const betas: string[] = [];
  if (!isHaiku) betas.push(CLAUDE_CODE_CLI_BETA);
  if (includeOAuth) betas.push(CLAUDE_CODE_OAUTH_BETA);
  if (isClaudeCodeOneMillionContext(model)) betas.push(CLAUDE_CODE_CONTEXT_1M_BETA);
  if (supportsInterleaved && !isTruthyEnv(process.env.DISABLE_INTERLEAVED_THINKING)) {
    betas.push(CLAUDE_CODE_INTERLEAVED_THINKING_BETA);
  }
  if (!isClaude3 && !experimentalBetasDisabled) {
    betas.push(CLAUDE_CODE_CONTEXT_MANAGEMENT_BETA);
  }
  if (!experimentalBetasDisabled) betas.push(CLAUDE_CODE_PROMPT_CACHING_SCOPE_BETA);
  const supportsMidConversationSystem =
    cleanModel.includes('claude-opus-5') ||
    cleanModel.includes('claude-opus-4-8') ||
    cleanModel.includes('claude-sonnet-5') ||
    cleanModel.includes('claude-fable-5') ||
    cleanModel.includes('claude-mythos-5');
  if (supportsMidConversationSystem && !experimentalBetasDisabled) {
    betas.push(CLAUDE_CODE_MID_CONVERSATION_SYSTEM_BETA);
  }
  if (opts?.promptCacheTtl === '1h') betas.push(CLAUDE_CODE_EXTENDED_CACHE_TTL_BETA);
  return betas;
}

export function resolveClaudeCodeModel(
  model: ClaudeCodeModelAlias | null | undefined,
  accountInfo?: ClaudeCodeAccountInfo | null,
  opts?: ResolveClaudeCodeModelOptions,
): ClaudeCodeResolvedModel {
  const alias = normalizeClaudeCodeModelAlias(model);
  const requestedModel = resolveClaudeCodeRequestedModel(alias, accountInfo);
  const apiModel = stripClaudeCodeContextSuffix(requestedModel);
  const supportsAdaptive = supportsClaudeCodeAdaptiveThinking(apiModel);
  const supportsEffort = supportsClaudeCodeEffort(apiModel);
  const effort = getClaudeCodeEffort(apiModel, opts?.effort);
  const outputConfig = effort && supportsEffort ? { effort } : undefined;
  const thinkingDisplay = opts?.thinkingDisplay;
  const thinking = opts?.thinking === false || !supportsAdaptive
    ? undefined
    : {
      type: 'adaptive',
      ...(thinkingDisplay === 'summarized' || thinkingDisplay === 'omitted'
        ? { display: thinkingDisplay }
        : {}),
    };
  const betas = getClaudeCodeBetasForModel(requestedModel, opts?.includeOAuth ?? true, {
    hasEffort: Boolean(outputConfig),
    thinkingDisplay: opts?.thinkingDisplay,
    hasTools: opts?.hasTools,
    promptCacheTtl: opts?.promptCacheTtl,
  });
  return {
    alias,
    requestedModel,
    apiModel,
    displayModel: requestedModel,
    displayName: getClaudeCodeDisplayName(alias, requestedModel),
    maxTokens: getClaudeCodeDefaultMaxTokens(apiModel),
    betas,
    thinking,
    outputConfig,
    effort,
    supportsEffort,
    supportsAdaptiveThinking: supportsAdaptive,
    isOneMillionContext:
      isClaudeCodeOneMillionContext(requestedModel) || isClaudeCodeNativeOneMillionModel(requestedModel),
  };
}
