/**
 * Claude Code OAuth and wire helpers.
 *
 * Source of truth checked at implementation time:
 *   @anthropic-ai/claude-code@2.1.215
 *   build: 2026-07-19T00:01:04Z
 *   git:   316ce99628e89900bf0b1328fed3b8fec0c0c92d
 *
 * The official client uses PKCE OAuth and then calls Anthropic's normal
 * `/v1/messages` API with either:
 *   - Claude.ai OAuth bearer token + `anthropic-beta: oauth-2025-04-20`
 *   - a managed API key created by `/api/oauth/claude_cli/create_api_key`
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Agent as HttpAgent } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import type { AddressInfo } from 'node:net';
import nodeFetch, { type RequestInit as NodeFetchRequestInit } from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ProviderStore } from '@mcp/store/provider-store.js';

export const CLAUDE_CODE_PACKAGE_VERSION = '2.1.215';
export const CLAUDE_CODE_BUILD_TIME = '2026-07-19T00:01:04Z';
export const CLAUDE_CODE_GIT_SHA = '316ce99628e89900bf0b1328fed3b8fec0c0c92d';

export const CLAUDE_CODE_BASE_URL =
  process.env.CLAUDE_CODE_API_BASE_URL ?? 'https://api.anthropic.com';
export const CLAUDE_CODE_CLIENT_ID =
  process.env.CLAUDE_CODE_OAUTH_CLIENT_ID ?? '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const CLAUDE_CODE_VERSION =
  process.env.CLAUDE_CODE_VERSION ?? CLAUDE_CODE_PACKAGE_VERSION;
export const CLAUDE_CODE_OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_CODE_CLI_BETA = 'claude-code-20250219';
export const CLAUDE_CODE_INTERLEAVED_THINKING_BETA = 'interleaved-thinking-2025-05-14';
export const CLAUDE_CODE_CONTEXT_MANAGEMENT_BETA = 'context-management-2025-06-27';
export const CLAUDE_CODE_PROMPT_CACHING_SCOPE_BETA = 'prompt-caching-scope-2026-01-05';
export const CLAUDE_CODE_CONTEXT_1M_BETA = 'context-1m-2025-08-07';
export const CLAUDE_CODE_ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_CODE_SMALL_FAST_MODEL =
  process.env.ANTHROPIC_SMALL_FAST_MODEL ?? 'claude-haiku-4-5-20251001';
export const CLAUDE_CODE_DEFAULT_SONNET_MODEL =
  process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? 'claude-sonnet-5';
export const CLAUDE_CODE_DEFAULT_OPUS_MODEL =
  process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ?? 'claude-opus-4-8';
export const CLAUDE_CODE_CONFIGURED_REDIRECT_PORT = process.env.CLAUDE_CODE_OAUTH_PORT
  ? Number(process.env.CLAUDE_CODE_OAUTH_PORT)
  : null;
export const CLAUDE_CODE_REDIRECT_PORT = CLAUDE_CODE_CONFIGURED_REDIRECT_PORT ?? 1456;
export const CLAUDE_CODE_AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
export const CLAUDE_CODE_CONSOLE_AUTHORIZE_URL = 'https://platform.claude.com/oauth/authorize';
export const CLAUDE_CODE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_CODE_MANUAL_REDIRECT_URL = 'https://platform.claude.com/oauth/code/callback';

const CLAUDE_CODE_API_KEY_URL =
  `${CLAUDE_CODE_BASE_URL.replace(/\/$/, '')}/api/oauth/claude_cli/create_api_key`;
const CLAUDE_CODE_PROFILE_URL =
  `${CLAUDE_CODE_BASE_URL.replace(/\/$/, '')}/api/oauth/profile`;
const CLAUDE_CODE_ROLES_URL =
  `${CLAUDE_CODE_BASE_URL.replace(/\/$/, '')}/api/oauth/claude_cli/roles`;
const CLAUDE_CODE_METRICS_ENABLED_URL =
  `${CLAUDE_CODE_BASE_URL.replace(/\/$/, '')}/api/claude_code/organizations/metrics_enabled`;

export const CLAUDE_CODE_CONSOLE_SCOPES = ['org:create_api_key', 'user:profile'];
export const CLAUDE_CODE_AI_SCOPES = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
];
export const CLAUDE_CODE_ALL_SCOPES = [
  'org:create_api_key',
  ...CLAUDE_CODE_AI_SCOPES,
];
export const CLAUDE_CODE_DEFAULT_SCOPES = CLAUDE_CODE_AI_SCOPES;

// Email/SSO login can consume several minutes before Claude returns to the
// authorization page. Keep the loopback/PKCE state alive long enough for the
// user to sign in and explicitly reopen consent from the dashboard.
const FLOW_TIMEOUT_MS = 15 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

const pending = new Map<string, PendingFlow>();
const proxyAgents = new Map<string, HttpAgent | HttpsAgent>();
const pendingRefreshes = new Map<string, Promise<string | null>>();

export function disposeClaudeCodeOAuthResources(): void {
  for (const flow of pending.values()) {
    try { flow.server.closeAllConnections?.(); } catch { /* old Node */ }
    try { flow.server.close(); } catch { /* already closed */ }
  }
  pending.clear();
  for (const agent of proxyAgents.values()) {
    try { agent.destroy(); } catch { /* already closed */ }
  }
  proxyAgents.clear();
  pendingRefreshes.clear();
}

type ClaudeCodeFetch = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let testFetch: ClaudeCodeFetch | null = null;

interface PendingFlow {
  code_verifier: string;
  state: string;
  server: Server;
  port: number;
  createdAt: number;
  loginWithClaudeAi: boolean;
  fallbackScopes: string[];
  isManual: boolean;
  code?: string;
  error?: string;
}

export interface ClaudeCodeRuntimeContext {
  deviceId: string;
  sessionId: string;
  accountUuid: string;
}

export interface ClaudeCodeRequestMetadata {
  user_id: string;
}

export interface ClaudeCodeTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
  account?: { uuid?: string; email_address?: string };
  organization?: { uuid?: string };
}

export interface ClaudeCodeProfile {
  account?: {
    uuid?: string;
    email?: string;
    email_address?: string;
    display_name?: string;
    created_at?: string;
  };
  organization?: {
    uuid?: string;
    name?: string;
    organization_type?: string;
    rate_limit_tier?: string;
    seat_tier?: string;
    has_extra_usage_enabled?: boolean;
    billing_type?: string;
    subscription_created_at?: string;
    cc_onboarding_flags?: Record<string, unknown>;
    claude_code_trial_ends_at?: string | null;
    claude_code_trial_duration_days?: number | null;
  };
}

export interface ClaudeCodeRoles {
  organization_role?: string;
  workspace_role?: string;
  organization_name?: string;
}

export interface ClaudeCodeProfileInfo {
  subscriptionType: 'max' | 'pro' | 'enterprise' | 'team' | null;
  rateLimitTier: string | null;
  seatTier: string | null;
  hasExtraUsageEnabled: boolean | null;
  billingType: string | null;
  displayName?: string;
  accountCreatedAt?: string;
  subscriptionCreatedAt?: string;
  ccOnboardingFlags: Record<string, unknown>;
  claudeCodeTrialEndsAt: string | null;
  claudeCodeTrialDurationDays: number | null;
  rawProfile: ClaudeCodeProfile;
}

export type ClaudeCodeModelAlias =
  | 'default'
  | 'sonnet'
  | 'sonnet[1m]'
  | 'haiku'
  | 'opus'
  | 'opus[1m]'
  | string;

export type ClaudeCodeEffort = 'low' | 'medium' | 'high' | 'xhigh';

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
  /** Retained for call-site compatibility; current Claude Code betas do not depend on tools. */
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

export interface ClaudeCodeUsageSnapshot {
  source: 'official';
  packageVersion: string;
  buildTime: string;
  gitSha: string;
  authType: 'claude_ai' | 'api_key' | 'env_oauth';
  profile: ClaudeCodeProfile | null;
  profileInfo: ClaudeCodeProfileInfo | null;
  roles: ClaudeCodeRoles | null;
  metrics: {
    endpoint: string;
    metricsLoggingEnabled: boolean | null;
    hasError: boolean;
  };
  rateLimits: ClaudeCodeRateLimitSnapshot | null;
  lastResponse: ClaudeCodeLastResponseSnapshot | null;
  limitProbeError: string | null;
  notes: string[];
}

export interface ClaudeCodeRateLimitBucket {
  key: 'five_hour' | 'seven_day' | 'overage';
  label: string;
  utilization: number;
  resetsAt: number | null;
  windowSeconds: number | null;
}

export interface ClaudeCodeRateLimitSnapshot {
  source: 'headers' | 'quota_check';
  checkedAt: string;
  status: string;
  utilization: number | null;
  rateLimitType: string | null;
  resetsAt: number | null;
  isUsingOverage: boolean;
  overageStatus: string | null;
  overageResetsAt: number | null;
  overageDisabledReason: string | null;
  upgradePaths: string[];
  unifiedRateLimitFallbackAvailable: boolean;
  buckets: ClaudeCodeRateLimitBucket[];
}

export interface ClaudeCodeLastResponseSnapshot {
  checkedAt: string;
  status: number;
  ok: boolean;
  method: string;
  path: string;
  requestId: string | null;
  retryAfter: string | null;
  model: string | null;
  maxTokens: number | null;
  stream: boolean | null;
  betas: string[] | null;
  thinkingType: string | null;
  effort: string | null;
  betaHeader: string | null;
  rateLimits: ClaudeCodeRateLimitSnapshot | null;
  attempt: 'first' | 'retry';
  /** Anthropic returns this on retryable errors. Null when absent or 2xx. */
  xShouldRetry?: string | null;
  /** First ~200 chars of the response body for non-2xx responses. Null on 2xx. */
  bodyPreview?: string | null;
}

const CLAUDE_CODE_RATE_LIMIT_BUCKETS = [
  {
    key: 'five_hour',
    claim: '5h',
    label: 'session limit',
    windowSeconds: 18_000,
  },
  {
    key: 'seven_day',
    claim: '7d',
    label: 'weekly limit',
    windowSeconds: 604_800,
  },
  {
    key: 'overage',
    claim: 'overage',
    label: 'extra usage',
    windowSeconds: null,
  },
] as const satisfies ReadonlyArray<{
  key: ClaudeCodeRateLimitBucket['key'];
  claim: string;
  label: string;
  windowSeconds: number | null;
}>;

export interface StartClaudeCodeFlowResult {
  authorize_url: string;
  manual_authorize_url: string;
  state: string;
  port: number;
}

export type PollClaudeCodeFlowResult =
  | { status: 'pending' }
  | { status: 'expired' }
  | { status: 'error'; error: string }
  | {
    status: 'authorized';
    access_token: string;
    refresh_token: string | null;
    expires_at: number;
    refresh_token_expires_at: number | null;
    scope: string;
    auth_type: 'claude_ai' | 'api_key';
    api_key: string | null;
    profile: ClaudeCodeProfile | null;
    profile_info: ClaudeCodeProfileInfo | null;
    roles: ClaudeCodeRoles | null;
  };

export interface ClaudeCodeRequestSpec {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: Record<string, unknown> | null;
}

function getUserAgentSuffix(): string {
  const agentSdkVersion = process.env.CLAUDE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
    : '';
  const clientApp = process.env.CLAUDE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
    : '';
  const workload = process.env.CLAUDE_CODE_WORKLOAD
    ? `, workload/${process.env.CLAUDE_CODE_WORKLOAD}`
    : '';
  return `${process.env.CLAUDE_CODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workload}`;
}

export function getClaudeCodeUserAgent(): string {
  return (
    process.env.CLAUDE_CODE_USER_AGENT ??
    `claude-cli/${CLAUDE_CODE_VERSION} (external, ${getUserAgentSuffix()})`
  );
}

export function getClaudeCodeMcpUserAgent(): string {
  const parts = [
    process.env.CLAUDE_CODE_ENTRYPOINT,
    process.env.CLAUDE_AGENT_SDK_VERSION
      ? `agent-sdk/${process.env.CLAUDE_AGENT_SDK_VERSION}`
      : undefined,
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP
      ? `client-app/${process.env.CLAUDE_AGENT_SDK_CLIENT_APP}`
      : undefined,
  ].filter((p): p is string => !!p);
  return `claude-code/${CLAUDE_CODE_VERSION}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

export function getClaudeCodeWebFetchUserAgent(): string {
  return `Claude-User (${getClaudeCodeMcpUserAgent()}; +https://support.anthropic.com/)`;
}

export const CLAUDE_CODE_USER_AGENT = getClaudeCodeUserAgent();
export const CLAUDE_CODE_MCP_USER_AGENT = getClaudeCodeMcpUserAgent();

export const CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_AGENT_SDK_SYSTEM_PROMPT =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
export const CLAUDE_CODE_AGENT_SYSTEM_PROMPT =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

export const CLAUDE_CODE_BILLING_SOURCE = 'cli';

/**
 * Mirrors `Og8()` in the upstream bundle. The wire format is a literal
 * `x-anthropic-billing-header: ...` string carried as the FIRST text block of
 * the `system` array (not as an HTTP header). Source is fixed to `cli` so the
 * billing/telemetry attribution lines up with `User-Agent: claude-cli/...`
 * and `x-app: cli`. Returns empty when CLAUDE_CODE_ATTRIBUTION_HEADER opts out.
 */
export function buildClaudeCodeBillingHeaderText(): string {
  const attribution = process.env.CLAUDE_CODE_ATTRIBUTION_HEADER?.trim().toLowerCase();
  if (
    attribution === 'false' ||
    attribution === 'off' ||
    attribution === '0' ||
    isTruthyEnv(process.env.CLAUDE_CODE_DISABLE_ATTRIBUTION_HEADER)
  ) {
    return '';
  }
  const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? 'unknown';
  const workload = process.env.CLAUDE_CODE_WORKLOAD
    ? ` cc_workload=${process.env.CLAUDE_CODE_WORKLOAD};`
    : '';
  return (
    `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.${CLAUDE_CODE_BILLING_SOURCE};` +
    ` cc_entrypoint=${entrypoint}; cch=00000;${workload}`
  );
}

/**
 * The two text blocks that must lead the `system` array on every OAuth call.
 * Mirrors how the upstream bundle assembles `system` (`Og8` billing block +
 * `Mg8` identity block prepended in this order — see claude.bundle.pretty.js
 * around line 473637 / 474892). Without this prefix Anthropic's OAuth tier
 * classifies the request as out-of-spec and rate-limits it (429), even though
 * Bearer + `oauth-2025-04-20` + the runtime headers are otherwise correct.
 */
export function getClaudeCodeSystemPrefixBlocks(): Array<{
  type: 'text';
  text: string;
}> {
  const blocks: Array<{ type: 'text'; text: string }> = [];
  const billing = buildClaudeCodeBillingHeaderText();
  if (billing) blocks.push({ type: 'text', text: billing });
  blocks.push({ type: 'text', text: CLAUDE_CODE_IDENTITY_SYSTEM_PROMPT });
  return blocks;
}

function parseAnthropicCustomHeaders(): Record<string, string> {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return {};
  const headers: Record<string, string> = {};
  for (const line of raw.split(/\n|\r\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

function stringExtra(extra: Record<string, unknown> | undefined, key: string): string | null {
  const value = extra?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

function getAccountUuidFromExtra(extra: Record<string, unknown> | undefined): string {
  const direct = stringExtra(extra, 'account_uuid') ?? stringExtra(extra, 'accountUuid');
  if (direct) return direct;
  const profile = extra?.profile as ClaudeCodeProfile | undefined;
  return profile?.account?.uuid ?? '';
}

let fallbackRuntimeContext: ClaudeCodeRuntimeContext | null = null;

export function getClaudeCodeRuntimeContext(
  store?: ProviderStore | null,
  providerId?: string | null,
): ClaudeCodeRuntimeContext {
  const tok = store && providerId ? store.getOAuth(providerId) : null;
  const extra = (tok?.extra ?? {}) as Record<string, unknown>;
  const deviceId =
    stringExtra(extra, 'claude_code_user_id') ??
    stringExtra(extra, 'claude_code_device_id') ??
    fallbackRuntimeContext?.deviceId ??
    randomBytes(32).toString('hex');
  const sessionId =
    stringExtra(extra, 'claude_code_session_id') ??
    fallbackRuntimeContext?.sessionId ??
    randomUUID();
  const accountUuid = getAccountUuidFromExtra(extra) || fallbackRuntimeContext?.accountUuid || '';
  const context = { deviceId, sessionId, accountUuid };

  if (tok && providerId) {
    const changed =
      extra.claude_code_user_id !== deviceId ||
      extra.claude_code_session_id !== sessionId ||
      (accountUuid && extra.account_uuid !== accountUuid);
    if (changed) {
      store!.setOAuth({
        provider_id: providerId,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        expires_at: tok.expires_at,
        scope: tok.scope,
        extra: {
          ...tok.extra,
          claude_code_user_id: deviceId,
          claude_code_session_id: sessionId,
          account_uuid: accountUuid || tok.extra?.account_uuid,
        },
      });
    }
  } else {
    fallbackRuntimeContext = context;
  }

  return context;
}

export function getClaudeCodeRequestMetadata(
  store?: ProviderStore | null,
  providerId?: string | null,
): ClaudeCodeRequestMetadata {
  const ids = getClaudeCodeRuntimeContext(store, providerId);
  const extraRaw = process.env.CLAUDE_CODE_EXTRA_METADATA;
  let extra: Record<string, unknown> = {};
  if (extraRaw) {
    try {
      const parsed = JSON.parse(extraRaw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        extra = parsed as Record<string, unknown>;
      }
    } catch {
      /* Claude Code logs and ignores invalid metadata JSON. */
    }
  }
  return {
    user_id: JSON.stringify({
      ...extra,
      device_id: ids.deviceId,
      account_uuid: ids.accountUuid,
      session_id: ids.sessionId,
    }),
  };
}

export function getClaudeCodeRuntimeHeaders(
  store?: ProviderStore | null,
  providerId?: string | null,
): Record<string, string> {
  const ids = getClaudeCodeRuntimeContext(store, providerId);
  return {
    'x-app': process.env.CLAUDE_CODE_X_APP ?? 'cli',
    'User-Agent': getClaudeCodeUserAgent(),
    'X-Claude-Code-Session-Id': ids.sessionId,
    ...parseAnthropicCustomHeaders(),
    ...(process.env.CLAUDE_CODE_CONTAINER_ID
      ? { 'x-claude-remote-container-id': process.env.CLAUDE_CODE_CONTAINER_ID }
      : {}),
    ...(process.env.CLAUDE_CODE_REMOTE_SESSION_ID
      ? { 'x-claude-remote-session-id': process.env.CLAUDE_CODE_REMOTE_SESSION_ID }
      : {}),
    ...(process.env.CLAUDE_AGENT_SDK_CLIENT_APP
      ? { 'x-client-app': process.env.CLAUDE_AGENT_SDK_CLIENT_APP }
      : {}),
    ...(process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION
      ? { 'x-anthropic-additional-protection': 'true' }
      : {}),
  };
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
    case 'opus':
    case 'opus[1m]':
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
    case 'opus':
      return CLAUDE_CODE_DEFAULT_OPUS_MODEL;
    case 'opus[1m]':
      return `${CLAUDE_CODE_DEFAULT_OPUS_MODEL}[1m]`;
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
    cleanModel.includes('claude-opus-4-7') ||
    cleanModel.includes('claude-opus-4-8') ||
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
  if (lowerAlias === 'default' && cleanModel.includes('claude-opus-4-8')) {
    return 'Default (recommended) - Opus 4.8 with 1M context';
  }
  if (lowerAlias === 'default') {
    return 'Default (recommended) - Sonnet 5';
  }
  const oneMillion = isClaudeCodeOneMillionContext(requestedModel);
  if (lowerAlias === 'sonnet[1m]' || (oneMillion && cleanModel.includes('claude-sonnet-5'))) {
    return 'Sonnet (1M context) - Sonnet 5 with 1M context';
  }
  if (lowerAlias === 'opus[1m]' || (oneMillion && cleanModel.includes('claude-opus-4-8'))) {
    return 'Opus (1M context) - Opus 4.8 with 1M context';
  }
  if (lowerAlias === 'opus-4-6[1m]' || (oneMillion && cleanModel.includes('claude-opus-4-6'))) {
    return 'Opus 4.6 (1M context) - Opus 4.6 with 1M context';
  }
  if (cleanModel.includes('claude-haiku-4-5')) return 'Haiku - Haiku 4.5';
  if (cleanModel.includes('claude-opus-4-8')) return 'Opus - Opus 4.8';
  if (cleanModel.includes('claude-opus-4-7')) return 'Opus - Opus 4.7';
  if (cleanModel.includes('claude-opus-4-6')) return 'Opus - Opus 4.6';
  if (cleanModel.includes('claude-opus-4-5')) return 'Opus - Opus 4.5';
  if (cleanModel.includes('claude-sonnet-5')) return 'Sonnet - Sonnet 5';
  if (cleanModel.includes('claude-sonnet-4-6')) return 'Sonnet - Sonnet 4.6';
  if (cleanModel.includes('claude-sonnet-4-5')) return 'Sonnet - Sonnet 4.5';
  return requestedModel;
}

export function getClaudeCodeBetasForModel(
  model: string,
  includeOAuth = true,
  opts?: {
    hasEffort?: boolean;
    thinkingDisplay?: string | null;
    hasTools?: boolean;
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
  void opts;
  return betas;
}

export function getClaudeCodeBetasHeader(
  model: string,
  includeOAuth = true,
  opts?: { hasEffort?: boolean; thinkingDisplay?: string | null },
): string {
  return getClaudeCodeBetasForModel(model, includeOAuth, opts).join(',');
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

export function __setClaudeCodeFetchForTests(fetchImpl: ClaudeCodeFetch | null): void {
  testFetch = fetchImpl;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce(): { code_verifier: string; code_challenge: string } {
  const code_verifier = base64url(randomBytes(32));
  const code_challenge = base64url(createHash('sha256').update(code_verifier).digest());
  return { code_verifier, code_challenge };
}

export function parseScopes(scope: string | null | undefined): string[] {
  return scope?.split(/\s+/).filter(Boolean) ?? [];
}

export function hasInferenceScope(scope: string | null | undefined): boolean {
  return parseScopes(scope).includes('user:inference');
}

export function getClaudeCodeAuthorizeScopes(input?: {
  loginWithClaudeAi?: boolean;
  inferenceOnly?: boolean;
}): string[] {
  if (input?.inferenceOnly) return ['user:inference'];
  return input?.loginWithClaudeAi ?? true
    ? CLAUDE_CODE_AI_SCOPES
    : CLAUDE_CODE_CONSOLE_SCOPES;
}

function subscriptionTypeFromOrganizationType(
  organizationType: string | null | undefined,
): ClaudeCodeProfileInfo['subscriptionType'] {
  switch (organizationType) {
    case 'claude_max':
      return 'max';
    case 'claude_pro':
      return 'pro';
    case 'claude_enterprise':
      return 'enterprise';
    case 'claude_team':
      return 'team';
    default:
      return null;
  }
}

export function summarizeClaudeCodeProfile(profile: ClaudeCodeProfile): ClaudeCodeProfileInfo {
  return {
    subscriptionType: subscriptionTypeFromOrganizationType(profile.organization?.organization_type),
    rateLimitTier: profile.organization?.rate_limit_tier ?? null,
    seatTier: profile.organization?.seat_tier ?? null,
    hasExtraUsageEnabled: profile.organization?.has_extra_usage_enabled ?? null,
    billingType: profile.organization?.billing_type ?? null,
    displayName: profile.account?.display_name,
    accountCreatedAt: profile.account?.created_at,
    subscriptionCreatedAt: profile.organization?.subscription_created_at,
    ccOnboardingFlags: profile.organization?.cc_onboarding_flags ?? {},
    claudeCodeTrialEndsAt: profile.organization?.claude_code_trial_ends_at ?? null,
    claudeCodeTrialDurationDays:
      profile.organization?.claude_code_trial_duration_days ?? null,
    rawProfile: profile,
  };
}

export function buildClaudeCodeAuthUrl(input: {
  codeChallenge: string;
  state: string;
  port?: number;
  isManual?: boolean;
  loginWithClaudeAi?: boolean;
  inferenceOnly?: boolean;
  orgUUID?: string;
  loginHint?: string;
  loginMethod?: string;
}): string {
  const loginWithClaudeAi = input.loginWithClaudeAi ?? true;
  const authorize = new URL(
    loginWithClaudeAi ? CLAUDE_CODE_AUTHORIZE_URL : CLAUDE_CODE_CONSOLE_AUTHORIZE_URL,
  );
  const redirectUri = input.isManual
    ? CLAUDE_CODE_MANUAL_REDIRECT_URL
    : loopbackRedirectUri(input.port ?? CLAUDE_CODE_REDIRECT_PORT);
  const scopes = getClaudeCodeAuthorizeScopes({
    loginWithClaudeAi,
    inferenceOnly: input.inferenceOnly,
  });

  authorize.searchParams.append('code', 'true');
  authorize.searchParams.append('client_id', CLAUDE_CODE_CLIENT_ID);
  authorize.searchParams.append('response_type', 'code');
  authorize.searchParams.append('redirect_uri', redirectUri);
  authorize.searchParams.append('scope', scopes.join(' '));
  authorize.searchParams.append('code_challenge', input.codeChallenge);
  authorize.searchParams.append('code_challenge_method', 'S256');
  authorize.searchParams.append('state', input.state);
  if (input.orgUUID) authorize.searchParams.append('orgUUID', input.orgUUID);
  if (input.loginHint) authorize.searchParams.append('login_hint', input.loginHint);
  if (input.loginMethod) authorize.searchParams.append('login_method', input.loginMethod);

  return authorize.toString();
}

export function buildClaudeCodeTokenExchangeRequest(input: {
  code: string;
  state: string;
  codeVerifier: string;
  port?: number;
  isManual?: boolean;
  expiresIn?: number;
}): ClaudeCodeRequestSpec {
  const body: Record<string, unknown> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: input.isManual
      ? CLAUDE_CODE_MANUAL_REDIRECT_URL
      : loopbackRedirectUri(input.port ?? CLAUDE_CODE_REDIRECT_PORT),
    client_id: CLAUDE_CODE_CLIENT_ID,
    code_verifier: input.codeVerifier,
    state: input.state,
  };
  if (input.expiresIn !== undefined) body.expires_in = input.expiresIn;
  return {
    url: CLAUDE_CODE_TOKEN_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
  };
}

export function buildClaudeCodeRefreshRequest(input: {
  refreshToken: string;
  scopes?: string[];
  clientId?: string;
  expiresIn?: number;
}): ClaudeCodeRequestSpec {
  const body: Record<string, unknown> = {
    grant_type: 'refresh_token',
    refresh_token: input.refreshToken,
    client_id: input.clientId ?? CLAUDE_CODE_CLIENT_ID,
    scope: (input.scopes?.length ? input.scopes : CLAUDE_CODE_AI_SCOPES).join(' '),
  };
  if (input.expiresIn !== undefined) body.expires_in = input.expiresIn;
  return {
    url: CLAUDE_CODE_TOKEN_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
  };
}

export function buildClaudeCodeModelsUrl(baseURL = CLAUDE_CODE_BASE_URL): string {
  return `${baseURL.replace(/\/$/, '')}/v1/models?beta=true`;
}

function headerNumber(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeEpochSeconds(value: number | null): number | null {
  if (value === null) return null;
  return value > 10_000_000_000 ? Math.floor(value / 1000) : value;
}

function normalizeUtilization(value: number | null): number | null {
  if (value === null) return null;
  if (value < 0) return 0;
  if (value <= 1) return value;
  if (value <= 100) return value / 100;
  return 1;
}

function hasClaudeCodeRateLimitHeaders(headers: Headers): boolean {
  return [
    'anthropic-ratelimit-unified-status',
    'anthropic-ratelimit-unified-reset',
    'anthropic-ratelimit-unified-representative-claim',
    'anthropic-ratelimit-unified-fallback',
    'anthropic-ratelimit-unified-overage-status',
    'anthropic-ratelimit-unified-overage-reset',
    'anthropic-ratelimit-unified-overage-disabled-reason',
    'anthropic-ratelimit-unified-upgrade-paths',
    ...CLAUDE_CODE_RATE_LIMIT_BUCKETS.flatMap((bucket) => [
      `anthropic-ratelimit-unified-${bucket.claim}-utilization`,
      `anthropic-ratelimit-unified-${bucket.claim}-reset`,
    ]),
  ].some((name) => headers.has(name));
}

export function parseClaudeCodeRateLimitHeaders(
  headers: Headers,
  source: ClaudeCodeRateLimitSnapshot['source'] = 'headers',
): ClaudeCodeRateLimitSnapshot | null {
  if (!hasClaudeCodeRateLimitHeaders(headers)) return null;

  const representativeClaim =
    headers.get('anthropic-ratelimit-unified-representative-claim') || null;
  const overageStatus =
    headers.get('anthropic-ratelimit-unified-overage-status') || null;
  const status =
    headers.get('anthropic-ratelimit-unified-status') ||
    (representativeClaim || overageStatus ? 'rejected' : 'allowed');
  const resetsAt = normalizeEpochSeconds(
    headerNumber(headers, 'anthropic-ratelimit-unified-reset'),
  );
  const rateLimitType = representativeClaim;
  const overageResetsAt = normalizeEpochSeconds(
    headerNumber(headers, 'anthropic-ratelimit-unified-overage-reset'),
  );
  const overageDisabledReason =
    headers.get('anthropic-ratelimit-unified-overage-disabled-reason') || null;
  const upgradePaths = (headers.get('anthropic-ratelimit-unified-upgrade-paths') || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const unifiedRateLimitFallbackAvailable =
    headers.get('anthropic-ratelimit-unified-fallback') === 'available';

  const buckets = CLAUDE_CODE_RATE_LIMIT_BUCKETS.flatMap((bucket) => {
    const utilization = normalizeUtilization(
      headerNumber(headers, `anthropic-ratelimit-unified-${bucket.claim}-utilization`),
    );
    const reset = normalizeEpochSeconds(
      headerNumber(headers, `anthropic-ratelimit-unified-${bucket.claim}-reset`),
    );
    if (utilization === null || reset === null) return [];
    return [{
      key: bucket.key,
      label: bucket.label,
      utilization,
      resetsAt: reset,
      windowSeconds: bucket.windowSeconds,
    }];
  });

  const activeBucketDef = CLAUDE_CODE_RATE_LIMIT_BUCKETS.find(
    (bucket) => bucket.key === rateLimitType || bucket.claim === rateLimitType,
  );
  const activeBucket = activeBucketDef
    ? buckets.find((bucket) => bucket.key === activeBucketDef.key)
    : undefined;
  const fallbackUtilization =
    buckets.length > 0 ? Math.max(...buckets.map((bucket) => bucket.utilization)) : null;

  return {
    source,
    checkedAt: new Date().toISOString(),
    status,
    utilization: activeBucket?.utilization ?? fallbackUtilization,
    rateLimitType,
    resetsAt,
    isUsingOverage:
      status === 'rejected' &&
      (overageStatus === 'allowed' || overageStatus === 'allowed_warning'),
    overageStatus,
    overageResetsAt,
    overageDisabledReason,
    upgradePaths,
    unifiedRateLimitFallbackAvailable,
    buckets,
  };
}

function storeClaudeCodeRateLimitsFromHeaders(
  store: ProviderStore,
  providerId: string,
  headers: Headers,
  source: ClaudeCodeRateLimitSnapshot['source'] = 'headers',
): ClaudeCodeRateLimitSnapshot | null {
  const snapshot = parseClaudeCodeRateLimitHeaders(headers, source);
  if (!snapshot) return null;
  const tok = store.getOAuth(providerId);
  if (!tok) return snapshot;
  store.setOAuth({
    provider_id: providerId,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_at,
    scope: tok.scope,
    extra: {
      ...tok.extra,
      rate_limits: snapshot,
    },
  });
  return snapshot;
}

function requestPath(url: RequestInfo | URL): string {
  const raw = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  try {
    const parsed = new URL(raw);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return raw;
  }
}

function safeRequestBodyFields(body: BodyInit | null | undefined): {
  model: string | null;
  maxTokens: number | null;
  stream: boolean | null;
  betas: string[] | null;
  thinkingType: string | null;
  effort: string | null;
} {
  if (typeof body !== 'string') {
    return {
      model: null,
      maxTokens: null,
      stream: null,
      betas: null,
      thinkingType: null,
      effort: null,
    };
  }
  try {
    const parsed = JSON.parse(body) as {
      model?: unknown;
      max_tokens?: unknown;
      stream?: unknown;
      betas?: unknown;
      thinking?: { type?: unknown };
      output_config?: { effort?: unknown };
    };
    return {
      model: typeof parsed.model === 'string' ? parsed.model : null,
      maxTokens: typeof parsed.max_tokens === 'number' ? parsed.max_tokens : null,
      stream: typeof parsed.stream === 'boolean' ? parsed.stream : null,
      betas: Array.isArray(parsed.betas)
        ? parsed.betas.filter((beta): beta is string => typeof beta === 'string')
        : null,
      thinkingType:
        typeof parsed.thinking?.type === 'string' ? parsed.thinking.type : null,
      effort:
        typeof parsed.output_config?.effort === 'string'
          ? parsed.output_config.effort
          : null,
    };
  } catch {
    return {
      model: null,
      maxTokens: null,
      stream: null,
      betas: null,
      thinkingType: null,
      effort: null,
    };
  }
}

async function storeClaudeCodeLastResponse(
  store: ProviderStore,
  providerId: string,
  response: Response,
  requestUrl: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Headers,
  rateLimits: ClaudeCodeRateLimitSnapshot | null,
  attempt: ClaudeCodeLastResponseSnapshot['attempt'],
): Promise<void> {
  const path = requestPath(requestUrl);
  const shouldStore =
    path.includes('/v1/messages') ||
    !response.ok ||
    rateLimits?.status === 'rejected' ||
    rateLimits?.status === 'allowed_warning';
  if (!shouldStore) return;
  const tok = store.getOAuth(providerId);
  if (!tok) return;

  let bodyPreview: string | null = null;
  if (!response.ok) {
    try {
      const text = await response.clone().text();
      bodyPreview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
    } catch {
      bodyPreview = null;
    }
  }

  const bodyFields = safeRequestBodyFields(init?.body);
  const snapshot: ClaudeCodeLastResponseSnapshot = {
    checkedAt: new Date().toISOString(),
    status: response.status,
    ok: response.ok,
    method: init?.method ?? 'GET',
    path,
    requestId:
      response.headers.get('request-id') ??
      response.headers.get('anthropic-request-id') ??
      response.headers.get('x-request-id'),
    retryAfter: response.headers.get('retry-after'),
    model: bodyFields.model,
    maxTokens: bodyFields.maxTokens,
    stream: bodyFields.stream,
    betas: bodyFields.betas,
    thinkingType: bodyFields.thinkingType,
    effort: bodyFields.effort,
    betaHeader: headers.get('anthropic-beta'),
    rateLimits,
    attempt,
    xShouldRetry: response.headers.get('x-should-retry'),
    bodyPreview,
  };

  store.setOAuth({
    provider_id: providerId,
    access_token: tok.access_token,
    refresh_token: tok.refresh_token,
    expires_at: tok.expires_at,
    scope: tok.scope,
    extra: {
      ...tok.extra,
      last_response: snapshot,
    },
  });
}

function loopbackRedirectUri(port: number): string {
  return `http://localhost:${port}/callback`;
}

function cleanupExpired(): void {
  const now = Date.now();
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > FLOW_TIMEOUT_MS) {
      try {
        flow.server.close();
      } catch {
        /* ignore */
      }
      pending.delete(state);
    }
  }
}

export async function startOAuthFlow(opts?: {
  loginWithClaudeAi?: boolean;
  inferenceOnly?: boolean;
  orgUUID?: string;
  loginHint?: string;
  loginMethod?: string;
}): Promise<StartClaudeCodeFlowResult> {
  cleanupExpired();
  for (const [state, flow] of pending) {
    try {
      flow.server.close();
    } catch {
      /* ignore */
    }
    pending.delete(state);
  }

  const loginWithClaudeAi = opts?.loginWithClaudeAi ?? true;
  const { code_verifier, code_challenge } = generatePkce();
  const state = base64url(randomBytes(32));
  let actualPort = CLAUDE_CODE_CONFIGURED_REDIRECT_PORT ?? 0;

  const server = createServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end('not found');
        return;
      }
      const qsState = url.searchParams.get('state') ?? '';
      const flow = pending.get(qsState);
      if (!flow || flow.state !== qsState) {
        res.writeHead(400, { 'Content-Type': 'text/html' }).end(
          '<html><body><h3>Invalid state</h3><p>You can close this tab.</p></body></html>',
        );
        return;
      }
      const qsError = url.searchParams.get('error') ?? '';
      const qsCode = url.searchParams.get('code') ?? '';
      if (qsError) flow.error = qsError;
      else if (qsCode) {
        flow.code = qsCode;
        flow.isManual = false;
      }
      else flow.error = 'no_code_or_error';

      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<html><body style="font-family:sans-serif;padding:2rem"><h3>Connected</h3><p>You can close this tab and return to the dashboard.</p><script>setTimeout(() => window.close(), 500);</script></body></html>',
      );
      setTimeout(() => {
        try {
          server.close();
        } catch {
          /* ignore */
        }
      }, 200);
    } catch (e) {
      res.writeHead(500).end((e as Error).message);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => reject(e);
    server.once('error', onError);
    server.listen(CLAUDE_CODE_CONFIGURED_REDIRECT_PORT ?? 0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error('failed to bind loopback server'));
        return;
      }
      actualPort = addr.port;
      server.off('error', onError);
      resolve();
    });
  });

  pending.set(state, {
    code_verifier,
    state,
    server,
    port: actualPort,
    createdAt: Date.now(),
    loginWithClaudeAi,
    fallbackScopes: getClaudeCodeAuthorizeScopes({
      loginWithClaudeAi,
      inferenceOnly: opts?.inferenceOnly,
    }),
    isManual: false,
  });

  const authorizeUrl = buildClaudeCodeAuthUrl({
    codeChallenge: code_challenge,
    state,
    port: actualPort,
    loginWithClaudeAi,
    inferenceOnly: opts?.inferenceOnly,
    orgUUID: opts?.orgUUID,
    loginHint: opts?.loginHint,
    loginMethod: opts?.loginMethod,
  });
  const manualAuthorizeUrl = buildClaudeCodeAuthUrl({
    codeChallenge: code_challenge,
    state,
    port: actualPort,
    isManual: true,
    loginWithClaudeAi,
    inferenceOnly: opts?.inferenceOnly,
    orgUUID: opts?.orgUUID,
    loginHint: opts?.loginHint,
    loginMethod: opts?.loginMethod,
  });

  return {
    authorize_url: authorizeUrl,
    manual_authorize_url: manualAuthorizeUrl,
    state,
    port: actualPort,
  };
}

function noProxyMatches(hostname: string, port: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const [entryHost, entryPort] = entry.includes(':') ? entry.split(':', 2) : [entry, ''];
    if (entryPort && entryPort !== port) continue;
    if (entryHost.startsWith('.')) {
      if (host.endsWith(entryHost)) return true;
    } else if (host === entryHost || host.endsWith(`.${entryHost}`)) {
      return true;
    }
  }
  return false;
}

function proxyUrlFor(target: URL): string | null {
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  if (noProxyMatches(target.hostname, port, noProxy)) return null;

  return (
    process.env.CLAUDE_CODE_PROXY_URL ??
    (target.protocol === 'https:' ? process.env.HTTPS_PROXY ?? process.env.https_proxy : undefined) ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    process.env.ALL_PROXY ??
    process.env.all_proxy ??
    null
  );
}

function getProxyAgent(proxyUrl: string): HttpAgent | HttpsAgent {
  let agent = proxyAgents.get(proxyUrl);
  if (!agent) {
    agent = new HttpsProxyAgent(proxyUrl);
    proxyAgents.set(proxyUrl, agent);
  }
  return agent;
}

async function fetchWithClaudeCodeNetwork(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url,
  );
  const proxyUrl = proxyUrlFor(url);
  if (!proxyUrl) {
    return (await nodeFetch(url.toString(), init as NodeFetchRequestInit)) as unknown as Response;
  }

  const nodeInit = {
    ...(init as NodeFetchRequestInit | undefined),
    agent: getProxyAgent(proxyUrl),
  } as NodeFetchRequestInit;
  return (await nodeFetch(url.toString(), nodeInit)) as unknown as Response;
}

export async function claudeCodeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (
    isTruthyEnv(process.env.CLAUDE_CODE_DEBUG_REQUEST) &&
    String(input).includes('/v1/messages')
  ) {
    const headers = new Headers(init?.headers);
    const authHdr = headers.get('authorization') ?? headers.get('Authorization');
    const xApiKey = headers.get('x-api-key');
    const tokenPreview = authHdr
      ? `${authHdr.slice(0, 16)}…${authHdr.slice(-6)} (len=${authHdr.length})`
      : null;
    const apiKeyPreview = xApiKey
      ? `${xApiKey.slice(0, 12)}…${xApiKey.slice(-4)} (len=${xApiKey.length})`
      : null;
    const bodyPreview = (() => {
      if (typeof init?.body !== 'string') return '<non-string body>';
      try {
        const parsed = JSON.parse(init.body) as {
          model?: string;
          betas?: string[];
          system?: unknown;
        };
        const sys = Array.isArray(parsed.system)
          ? (parsed.system as Array<{ type?: string; text?: string }>)
              .slice(0, 3)
              .map((b) => `[${b.type ?? '?'}] ${(b.text ?? '').slice(0, 80)}`)
          : typeof parsed.system === 'string'
            ? [(parsed.system as string).slice(0, 80)]
            : ['<no system>'];
        return JSON.stringify({ model: parsed.model, betas: parsed.betas, systemHead: sys });
      } catch {
        return '<unparseable body>';
      }
    })();
    console.error(
      '[claude-code:debug] base fetch (no retry wrapper)',
      JSON.stringify(
        {
          url: String(input),
          method: init?.method ?? 'GET',
          authPath: xApiKey ? 'api_key (x-api-key)' : authHdr ? 'bearer' : 'no-auth',
          authHeader: tokenPreview,
          xApiKey: apiKeyPreview,
          anthropicBeta: headers.get('anthropic-beta'),
          userAgent: headers.get('user-agent') ?? headers.get('User-Agent'),
          xApp: headers.get('x-app'),
          body: bodyPreview,
        },
        null,
        2,
      ),
    );
  }
  return (testFetch ?? fetchWithClaudeCodeNetwork)(input, init);
}

async function postJson<T>(spec: ClaudeCodeRequestSpec, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await claudeCodeFetch(spec.url, {
      method: spec.method,
      headers: spec.headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      signal: controller.signal,
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status} ${await r.text()}`);
    }
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeCode(
  code: string,
  state: string,
  verifier: string,
  port: number,
  isManual: boolean,
): Promise<ClaudeCodeTokenResponse> {
  return postJson<ClaudeCodeTokenResponse>(
    buildClaudeCodeTokenExchangeRequest({
      code,
      state,
      codeVerifier: verifier,
      port,
      isManual,
    }),
  );
}

export function submitManualClaudeCode(
  state: string,
  manualCode: string,
): { status: 'ok' } | { status: 'expired' } | { status: 'error'; error: string } {
  cleanupExpired();
  const flow = pending.get(state);
  if (!flow) return { status: 'expired' };

  const trimmed = manualCode.trim();
  if (!trimmed) return { status: 'error', error: 'manual code required' };

  const separator = trimmed.indexOf('#');
  const code = separator === -1 ? trimmed : trimmed.slice(0, separator).trim();
  const returnedState = separator === -1 ? '' : trimmed.slice(separator + 1).trim();

  if (!code) return { status: 'error', error: 'manual code required' };
  if (returnedState && returnedState !== state) {
    return { status: 'error', error: 'manual code state mismatch' };
  }

  flow.code = code;
  flow.isManual = true;
  try {
    flow.server.close();
  } catch {
    /* ignore */
  }
  return { status: 'ok' };
}

export async function refreshOAuthToken(
  refreshToken: string,
  opts?: { scopes?: string[]; expiresIn?: number; clientId?: string },
): Promise<ClaudeCodeTokenResponse> {
  return postJson<ClaudeCodeTokenResponse>(
    buildClaudeCodeRefreshRequest({
      refreshToken,
      scopes: opts?.scopes,
      expiresIn: opts?.expiresIn,
      clientId: opts?.clientId,
    }),
  );
}

async function fetchJsonOrNull<T>(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await claudeCodeFetch(url, { ...init, signal: controller.signal }).catch(() => null);
    if (!r?.ok) return null;
    return (await r.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchProfile(accessToken: string): Promise<ClaudeCodeProfile | null> {
  return fetchJsonOrNull<ClaudeCodeProfile>(
    CLAUDE_CODE_PROFILE_URL,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    },
    10_000,
  );
}

export async function fetchProfileInfo(
  accessToken: string,
): Promise<ClaudeCodeProfileInfo | null> {
  const profile = await fetchProfile(accessToken);
  return profile ? summarizeClaudeCodeProfile(profile) : null;
}

export async function fetchRoles(accessToken: string): Promise<ClaudeCodeRoles | null> {
  return fetchJsonOrNull<ClaudeCodeRoles>(
    CLAUDE_CODE_ROLES_URL,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    10_000,
  );
}

async function createApiKey(accessToken: string): Promise<string | null> {
  const r = await claudeCodeFetch(CLAUDE_CODE_API_KEY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    throw new Error(`Claude Code API key creation failed: HTTP ${r.status} ${await r.text()}`);
  }
  const data = (await r.json()) as { raw_key?: string };
  return data.raw_key ?? null;
}

export async function pollFlow(state: string): Promise<PollClaudeCodeFlowResult> {
  cleanupExpired();
  const flow = pending.get(state);
  if (!flow) return { status: 'expired' };
  if (flow.error) {
    pending.delete(state);
    return { status: 'error', error: flow.error };
  }
  if (!flow.code) return { status: 'pending' };

  try {
    const tok = await exchangeCode(
      flow.code,
      flow.state,
      flow.code_verifier,
      flow.port,
      flow.isManual,
    );
    pending.delete(state);
    const authorizedAt = Date.now();
    const expires_in = tok.expires_in ?? 3600;
    const fallbackScope = flow.fallbackScopes.join(' ');
    const scope = tok.scope ?? fallbackScope;
    const authType = hasInferenceScope(scope) ? 'claude_ai' : 'api_key';
    const [profile, roles] = await Promise.all([
      fetchProfile(tok.access_token),
      fetchRoles(tok.access_token),
    ]);
    const profileInfo = profile ? summarizeClaudeCodeProfile(profile) : null;
    const apiKey = authType === 'api_key' ? await createApiKey(tok.access_token) : null;

    return {
      status: 'authorized',
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      expires_at: authorizedAt + expires_in * 1000,
      refresh_token_expires_at: tok.refresh_token_expires_in
        ? authorizedAt + tok.refresh_token_expires_in * 1000
        : null,
      scope,
      auth_type: authType,
      api_key: apiKey,
      profile,
      profile_info: profileInfo,
      roles,
    };
  } catch (e) {
    pending.delete(state);
    return { status: 'error', error: (e as Error).message };
  }
}

async function refreshClaudeCodeTokenNow(
  store: ProviderStore,
  providerId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok) return null;

  const authType = tok.extra?.auth_type;
  if (authType !== 'claude_ai' && !hasInferenceScope(tok.scope)) {
    return tok.access_token;
  }

  const now = Date.now();
  const stillValid = tok.expires_at && tok.expires_at - now > TOKEN_REFRESH_SKEW_MS;
  if (!opts?.force && stillValid) return tok.access_token;
  if (!tok.refresh_token) return tok.access_token;

  const scopes = parseScopes(tok.scope);
  const data = await refreshOAuthToken(tok.refresh_token, {
    clientId: (tok.extra?.client_id as string | undefined) ?? CLAUDE_CODE_CLIENT_ID,
    scopes: scopes.length > 0 ? scopes : CLAUDE_CODE_AI_SCOPES,
  });
  const expires_at = Date.now() + (data.expires_in ?? 3600) * 1000;
  const [profile, roles] = await Promise.all([
    fetchProfile(data.access_token),
    fetchRoles(data.access_token),
  ]);
  const profileInfo = profile ? summarizeClaudeCodeProfile(profile) : null;
  store.setOAuth({
    provider_id: providerId,
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tok.refresh_token,
    expires_at,
    scope: data.scope ?? tok.scope,
    extra: {
      ...tok.extra,
      auth_type: 'claude_ai',
      client_id: CLAUDE_CODE_CLIENT_ID,
      refresh_token_expires_at: data.refresh_token_expires_in
        ? Date.now() + data.refresh_token_expires_in * 1000
        : tok.extra?.refresh_token_expires_at ?? null,
      account_uuid: profile?.account?.uuid ?? tok.extra?.account_uuid ?? null,
      organization_uuid:
        profile?.organization?.uuid ?? tok.extra?.organization_uuid ?? null,
      profile: profile ?? tok.extra?.profile,
      profile_info: profileInfo ?? tok.extra?.profile_info,
      roles: roles ?? tok.extra?.roles,
      subscription_type:
        profileInfo?.subscriptionType ?? tok.extra?.subscription_type ?? null,
      rate_limit_tier: profileInfo?.rateLimitTier ?? tok.extra?.rate_limit_tier ?? null,
      seat_tier: profileInfo?.seatTier ?? tok.extra?.seat_tier ?? null,
      billing_type: profileInfo?.billingType ?? tok.extra?.billing_type ?? null,
      has_extra_usage_enabled:
        profileInfo?.hasExtraUsageEnabled ?? tok.extra?.has_extra_usage_enabled ?? null,
    },
  });
  return data.access_token;
}

/**
 * Refresh-token rotation is single-flight per provider. Claude's refresh token
 * may rotate on every exchange, so concurrent agent turns must never redeem the
 * same old token independently.
 */
export async function refreshIfExpired(
  store: ProviderStore,
  providerId: string,
  opts?: { force?: boolean },
): Promise<string | null> {
  const tok = store.getOAuth(providerId);
  if (!tok) return null;
  const usesClaudeAi = tok.extra?.auth_type === 'claude_ai' || hasInferenceScope(tok.scope);
  if (!usesClaudeAi) return tok.access_token;
  const stillValid = tok.expires_at && tok.expires_at - Date.now() > TOKEN_REFRESH_SKEW_MS;
  if (!opts?.force && stillValid) return tok.access_token;
  if (!tok.refresh_token) return tok.access_token;

  const existing = pendingRefreshes.get(providerId);
  if (existing) return existing;

  const refresh = refreshClaudeCodeTokenNow(store, providerId, opts).finally(() => {
    if (pendingRefreshes.get(providerId) === refresh) pendingRefreshes.delete(providerId);
  });
  pendingRefreshes.set(providerId, refresh);
  return refresh;
}

async function shouldRetryAfterOAuthFailure(response: Response): Promise<boolean> {
  if (response.status === 401) return true;
  if (response.status !== 403) return false;
  try {
    const body = await response.clone().text();
    return body.includes('OAuth token has been revoked');
  } catch {
    return false;
  }
}

function ensureOAuthBetaHeader(headers: Headers): void {
  const existing = headers.get('anthropic-beta');
  if (!existing) {
    headers.set('anthropic-beta', CLAUDE_CODE_OAUTH_BETA);
    return;
  }
  const parts = existing.split(',').map((part) => part.trim()).filter(Boolean);
  if (!parts.includes(CLAUDE_CODE_OAUTH_BETA)) {
    headers.set('anthropic-beta', [...parts, CLAUDE_CODE_OAUTH_BETA].join(','));
  }
}

export function createClaudeCodeFetchWithRetry(
  store: ProviderStore,
  providerId: string,
): ClaudeCodeFetch {
  return async (url, init) => {
    const current = store.getOAuth(providerId);
    const firstHeaders = new Headers(init?.headers);
    const currentUsesOAuth =
      current?.extra?.auth_type === 'claude_ai' || hasInferenceScope(current?.scope);
    if (current?.access_token && currentUsesOAuth) {
      firstHeaders.set('Authorization', `Bearer ${current.access_token}`);
      ensureOAuthBetaHeader(firstHeaders);
    }

    if (isTruthyEnv(process.env.CLAUDE_CODE_DEBUG_REQUEST)) {
      const authHdr = firstHeaders.get('authorization') ?? firstHeaders.get('Authorization');
      const xApiKey = firstHeaders.get('x-api-key');
      const tokenPreview = authHdr
        ? `${authHdr.slice(0, 16)}…${authHdr.slice(-6)} (len=${authHdr.length})`
        : null;
      const apiKeyPreview = xApiKey
        ? `${xApiKey.slice(0, 12)}…${xApiKey.slice(-4)} (len=${xApiKey.length})`
        : null;
      const bodyPreview = (() => {
        if (typeof init?.body !== 'string') return '<non-string body>';
        try {
          const parsed = JSON.parse(init.body) as {
            model?: string;
            betas?: string[];
            system?: unknown;
          };
          const sys = Array.isArray(parsed.system)
            ? (parsed.system as Array<{ type?: string; text?: string }>)
                .slice(0, 3)
                .map((b) => `[${b.type ?? '?'}] ${(b.text ?? '').slice(0, 80)}`)
            : typeof parsed.system === 'string'
              ? [(parsed.system as string).slice(0, 80)]
              : ['<no system>'];
          return JSON.stringify({ model: parsed.model, betas: parsed.betas, systemHead: sys });
        } catch {
          return '<unparseable body>';
        }
      })();
      console.error(
        '[claude-code:debug] outgoing request',
        JSON.stringify(
          {
            url: String(url),
            method: init?.method ?? 'GET',
            authPath: currentUsesOAuth ? 'claude_ai (Bearer)' : 'api_key',
            authHeader: tokenPreview,
            xApiKey: apiKeyPreview,
            anthropicBeta: firstHeaders.get('anthropic-beta'),
            userAgent: firstHeaders.get('user-agent') ?? firstHeaders.get('User-Agent'),
            xApp: firstHeaders.get('x-app'),
            tokenAuthType: current?.extra?.auth_type ?? null,
            tokenScopeHasInference: hasInferenceScope(current?.scope),
            tokenExpiresAt: current?.expires_at ?? null,
            body: bodyPreview,
          },
          null,
          2,
        ),
      );
    }

    const first = await claudeCodeFetch(url, { ...init, headers: firstHeaders });
    const firstRateLimits = storeClaudeCodeRateLimitsFromHeaders(store, providerId, first.headers);
    await storeClaudeCodeLastResponse(
      store,
      providerId,
      first,
      url,
      init,
      firstHeaders,
      firstRateLimits,
      'first',
    );
    if (!(await shouldRetryAfterOAuthFailure(first))) return first;

    const fresh = await refreshIfExpired(store, providerId, { force: true }).catch(() => null);
    if (!fresh) return first;

    const headers = new Headers(firstHeaders);
    headers.set('Authorization', `Bearer ${fresh}`);
    ensureOAuthBetaHeader(headers);
    const retried = await claudeCodeFetch(url, { ...init, headers });
    const retryRateLimits = storeClaudeCodeRateLimitsFromHeaders(store, providerId, retried.headers);
    await storeClaudeCodeLastResponse(
      store,
      providerId,
      retried,
      url,
      init,
      headers,
      retryRateLimits,
      'retry',
    );
    return retried;
  };
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

export async function fetchClaudeCodeModels(input: {
  baseURL?: string | null;
  apiKey?: string | null;
  authToken?: string | null;
  headers?: Record<string, string>;
  fetch?: ClaudeCodeFetch;
}): Promise<Array<{ id: string; display_name?: string }>> {
  const fetcher = input.fetch ?? claudeCodeFetch;
  const r = await fetcher(buildClaudeCodeModelsUrl(input.baseURL ?? CLAUDE_CODE_BASE_URL), {
    headers: {
      ...claudeCodeAuthHeaders({
        apiKey: input.apiKey,
        authToken: input.authToken,
      }),
      ...input.headers,
      'anthropic-version': CLAUDE_CODE_ANTHROPIC_VERSION,
    },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${await r.text()}`);
  const data = (await r.json()) as { data?: Array<{ id: string; display_name?: string }> };
  return data.data ?? [];
}

async function fetchMetricsEnabled(input: {
  apiKey?: string | null;
  authToken?: string | null;
  fetch?: ClaudeCodeFetch;
}): Promise<{ metrics_logging_enabled?: boolean } | null> {
  const fetcher = input.fetch ?? claudeCodeFetch;
  const r = await fetcher(CLAUDE_CODE_METRICS_ENABLED_URL, {
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': getClaudeCodeMcpUserAgent(),
      ...claudeCodeAuthHeaders({
        apiKey: input.apiKey,
        authToken: input.authToken,
        userAgent: getClaudeCodeMcpUserAgent(),
      }),
    },
  }).catch(() => null);
  if (!r?.ok) return null;
  return (await r.json()) as { metrics_logging_enabled?: boolean };
}

function pickClaudeCodeQuotaModel(store: ProviderStore, providerId: string): string {
  if (process.env.ANTHROPIC_SMALL_FAST_MODEL) return process.env.ANTHROPIC_SMALL_FAST_MODEL;
  const enabledModels = store.listModels(providerId, true);
  const allModels = enabledModels.length > 0 ? enabledModels : store.listModels(providerId);
  return (
    allModels.find((model) => model.model_id === 'haiku')?.model_id ??
    allModels.find((model) => model.model_id === CLAUDE_CODE_SMALL_FAST_MODEL)?.model_id ??
    allModels.find((model) => /haiku/i.test(model.model_id))?.model_id ??
    'haiku'
  );
}

export async function probeClaudeCodeRateLimits(
  store: ProviderStore,
  providerId: string,
): Promise<ClaudeCodeRateLimitSnapshot | null> {
  const cfg = store.getProvider(providerId);
  if (!cfg) throw new Error('provider not found');

  const tok = store.getOAuth(providerId);
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const storedAuthType = tok?.extra?.auth_type as 'claude_ai' | 'api_key' | undefined;
  const authType = envToken
    ? 'env_oauth'
    : storedAuthType ?? (hasInferenceScope(tok?.scope) ? 'claude_ai' : 'api_key');
  const accessToken = envToken ?? (tok ? await refreshIfExpired(store, providerId) : null);
  const authToken = authType === 'api_key' ? null : accessToken;
  const apiKey = authType === 'api_key' ? cfg.api_key : null;
  const fetcher = tok ? createClaudeCodeFetchWithRetry(store, providerId) : claudeCodeFetch;
  const baseURL = (cfg.base_url ?? CLAUDE_CODE_BASE_URL).replace(/\/$/, '');
  const quotaModel = pickClaudeCodeQuotaModel(store, providerId);
  const resolvedQuotaModel = resolveClaudeCodeModel(quotaModel, null, {
    includeOAuth: authType !== 'api_key',
    thinking: false,
  });
  const runtimeHeaders = getClaudeCodeRuntimeHeaders(store, providerId);
  const metadata = getClaudeCodeRequestMetadata(store, providerId);
  const betaHeader = resolvedQuotaModel.betas.join(',');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetcher(`${baseURL}/v1/messages`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...runtimeHeaders,
        ...claudeCodeAuthHeaders({ apiKey, authToken }),
        ...(betaHeader ? { 'anthropic-beta': betaHeader } : {}),
        'anthropic-version': CLAUDE_CODE_ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
        'X-Stainless-Retry-Count': '0',
        'X-Stainless-Timeout': '600',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: resolvedQuotaModel.apiModel,
        max_tokens: 1,
        ...(authToken ? { system: getClaudeCodeSystemPrefixBlocks() } : {}),
        messages: [{ role: 'user', content: 'quota' }],
        metadata,
      }),
      signal: controller.signal,
    });
    const snapshot = storeClaudeCodeRateLimitsFromHeaders(
      store,
      providerId,
      response.headers,
      'quota_check',
    );
    if (response.ok || snapshot) {
      await response.arrayBuffer().catch(() => null);
      return snapshot ?? ((store.getOAuth(providerId)?.extra?.rate_limits as
        | ClaudeCodeRateLimitSnapshot
        | undefined) ?? null);
    }
    throw new Error(`HTTP ${response.status} ${await response.text()}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchClaudeCodeUsageSnapshot(
  store: ProviderStore,
  providerId: string,
  opts?: { probeRateLimits?: boolean },
): Promise<ClaudeCodeUsageSnapshot> {
  const cfg = store.getProvider(providerId);
  if (!cfg) throw new Error('provider not found');
  const tok = store.getOAuth(providerId);
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const storedAuthType = tok?.extra?.auth_type as 'claude_ai' | 'api_key' | undefined;
  const authType = envToken
    ? 'env_oauth'
    : storedAuthType ?? (hasInferenceScope(tok?.scope) ? 'claude_ai' : 'api_key');
  const accessToken = envToken ?? (tok ? await refreshIfExpired(store, providerId) : null);
  const authToken = authType === 'api_key' ? null : accessToken;
  const apiKey = authType === 'api_key' ? cfg.api_key : null;
  const retryFetch = tok ? createClaudeCodeFetchWithRetry(store, providerId) : claudeCodeFetch;
  let rateLimits =
    (tok?.extra?.rate_limits as ClaudeCodeRateLimitSnapshot | undefined) ?? null;
  let lastResponse =
    (tok?.extra?.last_response as ClaudeCodeLastResponseSnapshot | undefined) ?? null;
  let limitProbeError: string | null = null;

  const [profile, roles, metrics] = await Promise.all([
    authToken ? fetchProfile(authToken) : Promise.resolve((tok?.extra?.profile as ClaudeCodeProfile | undefined) ?? null),
    authToken ? fetchRoles(authToken) : Promise.resolve((tok?.extra?.roles as ClaudeCodeRoles | undefined) ?? null),
    fetchMetricsEnabled({ apiKey, authToken, fetch: retryFetch }),
  ]);
  const profileInfo =
    profile ? summarizeClaudeCodeProfile(profile) : (tok?.extra?.profile_info as ClaudeCodeProfileInfo | undefined) ?? null;

  if (opts?.probeRateLimits) {
    try {
      rateLimits = await probeClaudeCodeRateLimits(store, providerId);
    } catch (e) {
      limitProbeError = (e as Error).message;
    }
  }
  lastResponse =
    (store.getOAuth(providerId)?.extra?.last_response as
      | ClaudeCodeLastResponseSnapshot
      | undefined) ?? lastResponse;

  const snapshot: ClaudeCodeUsageSnapshot = {
    source: 'official',
    packageVersion: CLAUDE_CODE_PACKAGE_VERSION,
    buildTime: CLAUDE_CODE_BUILD_TIME,
    gitSha: CLAUDE_CODE_GIT_SHA,
    authType,
    profile,
    profileInfo,
    roles,
    metrics: {
      endpoint: CLAUDE_CODE_METRICS_ENABLED_URL,
      metricsLoggingEnabled: metrics?.metrics_logging_enabled ?? null,
      hasError: metrics === null,
    },
    rateLimits,
    lastResponse,
    limitProbeError,
    notes: [
      'Profile, roles, model discovery and metrics opt-out status are read from official Anthropic endpoints.',
      'Usage limits are read from official Claude Code rate-limit headers when present.',
      'No Claude Code telemetry/metrics POST is emitted by this server.',
      'Local token price estimates are intentionally not used for Claude Code OAuth.',
    ],
  };

  const latestTok = store.getOAuth(providerId) ?? tok;
  if (latestTok) {
    store.setOAuth({
      provider_id: providerId,
      access_token: latestTok.access_token,
      refresh_token: latestTok.refresh_token,
      expires_at: latestTok.expires_at,
      scope: latestTok.scope,
      extra: {
        ...latestTok.extra,
        profile: profile ?? latestTok.extra?.profile,
        profile_info: profileInfo ?? latestTok.extra?.profile_info,
        roles: roles ?? latestTok.extra?.roles,
        metrics_enabled:
          metrics?.metrics_logging_enabled ?? latestTok.extra?.metrics_enabled ?? null,
        rate_limits: rateLimits ?? latestTok.extra?.rate_limits ?? null,
        last_response: lastResponse ?? latestTok.extra?.last_response ?? null,
      },
    });
  }

  return snapshot;
}
