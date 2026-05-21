/**
 * CloudCode (Code Assist) API client — the same backend the Gemini CLI
 * uses for "Login with Google" OAuth flows.
 *
 * The Gemini CLI NEVER calls generativelanguage.googleapis.com with OAuth
 * tokens. Instead it routes through cloudcode-pa.googleapis.com which:
 *   - Accepts cloud-platform scope (the Gemini CLI's registered scope)
 *   - Wraps the standard Gemini generateContent API
 *   - Manages user tiers, quotas, and project binding
 *
 * Endpoints:
 *   POST /v1internal:loadCodeAssist     — handshake, returns project ID
 *   POST /v1internal:generateContent    — non-streaming generate
 *   POST /v1internal:streamGenerateContent?alt=sse — streaming generate
 */
import { OAuth2Client } from 'google-auth-library';
import { randomUUID } from 'node:crypto';
import { platform, arch } from 'node:os';

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const CODE_ASSIST_VERSION = 'v1internal';

// Re-export for convenience
export { OAuth2Client };

/**
 * User-Agent mimics the Gemini CLI format so CloudCode treats us as a
 * known client and applies the same rate-limit tiers.
 * Format: GeminiCLI/<version>/<model> (<platform>; <arch>; terminal)
 */
const GEMINI_CLI_VERSION = '0.42.0';
function userAgent(model?: string): string {
  return `GeminiCLI/${GEMINI_CLI_VERSION}/${model ?? 'unknown'} (${platform()}; ${arch()}; terminal)`;
}

/**
 * Cap on tokens the model can spend on hidden thinking, mirrors
 * `DEFAULT_THINKING_MODE` from gemini-cli's packages/core/src/config/models.ts.
 * Without a budget, Gemini 3.x can spiral into long internal monologues that
 * consume context without producing output. 8K is the upstream default and
 * what we apply on both the API-key and CloudCode paths.
 */
export const DEFAULT_THINKING_MODE = 8192;

// ─── Thought signature (mirrors gemini-cli) ─────────────────────

/**
 * Synthetic value that tells the Gemini API to skip thought_signature
 * validation. Same constant the Gemini CLI uses in
 * `ensureActiveLoopHasThoughtSignatures()`.
 */
const SYNTHETIC_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/**
 * When thinking mode is active, the Gemini API requires every `functionCall`
 * part in the conversation history to have a `thoughtSignature`. This walks
 * the contents array and injects the synthetic bypass value on any function
 * call parts that are missing one.
 */
function ensureThoughtSignatures(contents: unknown[]): unknown[] {
  return contents.map((content) => {
    const c = content as { role?: string; parts?: Array<Record<string, unknown>> };
    if (c.role !== 'model' || !c.parts) return content;
    let changed = false;
    const parts = c.parts.map((part) => {
      if (part.functionCall && !part.thoughtSignature) {
        changed = true;
        return { ...part, thoughtSignature: SYNTHETIC_THOUGHT_SIGNATURE };
      }
      return part;
    });
    return changed ? { ...c, parts } : content;
  });
}

// ─── Retry with backoff (mirrors gemini-cli) ────────────────────

const RETRY_MAX_ATTEMPTS = 10;
const RETRY_INITIAL_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 30_000;
const RETRY_JITTER = 0.3;
/** If the API suggests a retry delay > this, treat as terminal (give up). */
const RETRY_TERMINAL_THRESHOLD_MS = 300_000;

function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 499 || (status >= 500 && status <= 599);
}

/** Extract "retry in Xs" from error message, returns ms or null. */
function parseRetryDelay(message: string): number | null {
  const m = message.match(/retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*(s|ms)/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  return m[2] === 'ms' ? val : val * 1000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Retry wrapper with exponential backoff + jitter. Mirrors gemini-cli's
 * retryWithBackoff: initial 5s, doubles up to 30s, ±30% jitter, max 10
 * attempts. 429 with suggested delay > 300s is treated as terminal.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  let delay = RETRY_INITIAL_DELAY_MS;
  for (let attempt = 0; attempt < RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const e = err as { code?: number; status?: number; message?: string; response?: { status?: number } };
      const status = e.code ?? e.status ?? e.response?.status ?? 0;
      const msg = e.message ?? '';

      if (!isRetryableStatus(status)) throw err;

      // Check if the API suggests a delay
      const suggestedDelay = parseRetryDelay(msg);
      if (suggestedDelay && suggestedDelay > RETRY_TERMINAL_THRESHOLD_MS) {
        throw new Error(`Rate limit terminal: suggested retry delay ${Math.round(suggestedDelay / 1000)}s exceeds threshold. ${msg}`);
      }

      if (attempt >= RETRY_MAX_ATTEMPTS - 1) throw err;

      const useDelay = suggestedDelay ?? delay;
      const jitter = useDelay * RETRY_JITTER * (Math.random() * 2 - 1);
      const actualDelay = Math.min(Math.max(useDelay + jitter, 1000), RETRY_MAX_DELAY_MS);

      console.warn(`[cloudcode] ${status} on attempt ${attempt + 1}, retrying in ${Math.round(actualDelay)}ms...`);
      await sleep(actualDelay, signal);

      delay = Math.min(delay * 2, RETRY_MAX_DELAY_MS);
    }
  }
  throw new Error('withRetry: should not reach here');
}

/**
 * Create an authenticated OAuth2Client from stored credentials.
 */
export function createAuthClient(
  accessToken: string,
  refreshToken?: string | null,
  clientId?: string,
  clientSecret?: string,
): OAuth2Client {
  const client = new OAuth2Client({
    clientId: clientId ?? process.env.GOOGLE_OAUTH_CLIENT_ID ??
      '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    clientSecret: clientSecret ?? process.env.GOOGLE_OAUTH_CLIENT_SECRET ??
      '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',
  });
  client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken ?? undefined,
  });
  return client;
}

function methodUrl(method: string): string {
  return `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_VERSION}:${method}`;
}

// ─── Setup / Handshake ──────────────────────────────────────────

export interface SetupResult {
  projectId: string;
  tier: string;
  tierName: string;
}

/**
 * Call loadCodeAssist to discover the user's project ID and tier.
 * This is the first call after OAuth — mirrors Gemini CLI's setupUser().
 */
export async function setupCloudCode(authClient: OAuth2Client): Promise<SetupResult> {
  const res = await authClient.request<{
    cloudaicompanionProject?: string;
    currentTier?: { id?: string; name?: string };
    paidTier?: { id?: string; name?: string };
  }>({
    url: methodUrl('loadCodeAssist'),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
    body: JSON.stringify({
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
      },
    }),
  });

  const data = res.data;
  const projectId = data.cloudaicompanionProject ?? '';
  const tier = data.paidTier?.id ?? data.currentTier?.id ?? 'STANDARD';
  const tierName = data.paidTier?.name ?? data.currentTier?.name ?? 'Standard';

  return { projectId, tier, tierName };
}

// ─── Quota ──────────────────────────────────────────────────────

export interface QuotaBucket {
  modelId: string;
  /** Absolute remaining count — null when the API only returns fraction. */
  remainingAmount: number | null;
  /** Calculated total limit — null when remainingAmount is unavailable. */
  limit: number | null;
  /** Fraction remaining (0.0–1.0) — always present, primary data source. */
  remainingFraction: number;
  resetTime: string | null;
}

export interface UserQuota {
  tier: string;
  tierName: string;
  buckets: QuotaBucket[];
  credits: number | null;
}

/**
 * Retrieve per-model quota from CloudCode. Mirrors gemini-cli's
 * refreshUserQuota() → retrieveUserQuota call.
 */
export async function retrieveUserQuota(
  authClient: OAuth2Client,
  projectId: string,
): Promise<UserQuota> {
  // First get tier info via loadCodeAssist
  const setupRes = await authClient.request<{
    currentTier?: { id?: string; name?: string };
    paidTier?: {
      id?: string;
      name?: string;
      availableCredits?: Array<{ creditType?: string; creditAmount?: string }>;
    };
  }>({
    url: methodUrl('loadCodeAssist'),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
    body: JSON.stringify({
      cloudaicompanionProject: projectId,
      metadata: {
        ideType: 'IDE_UNSPECIFIED',
        platform: 'PLATFORM_UNSPECIFIED',
        pluginType: 'GEMINI',
        duetProject: projectId,
      },
      mode: 'HEALTH_CHECK',
    }),
  });

  const tierData = setupRes.data;
  const tier = tierData.paidTier?.id ?? tierData.currentTier?.id ?? 'standard-tier';
  const tierName = tierData.paidTier?.name ?? tierData.currentTier?.name ?? 'Standard';

  // Calculate Google One AI credits
  let credits: number | null = null;
  const g1 = (tierData.paidTier?.availableCredits ?? [])
    .filter((c) => c.creditType === 'GOOGLE_ONE_AI');
  if (g1.length > 0) {
    credits = g1.reduce((sum, c) => {
      const amt = parseInt(c.creditAmount ?? '0', 10);
      return sum + (isNaN(amt) ? 0 : amt);
    }, 0);
  }

  // Get per-model quota buckets
  const quotaRes = await authClient.request<{
    buckets?: Array<{
      modelId?: string;
      remainingAmount?: string;
      remainingFraction?: number;
      resetTime?: string;
    }>;
  }>({
    url: methodUrl('retrieveUserQuota'),
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent() },
    body: JSON.stringify({ project: projectId }),
  });

  const buckets: QuotaBucket[] = (quotaRes.data.buckets ?? [])
    .filter((b) => b.modelId && b.remainingFraction != null)
    .map((b) => {
      const fraction = b.remainingFraction ?? 0;
      const rawAmount = b.remainingAmount ? parseInt(b.remainingAmount, 10) : NaN;
      const hasAmount = !isNaN(rawAmount) && rawAmount > 0;
      return {
        modelId: b.modelId!,
        remainingAmount: hasAmount ? rawAmount : null,
        limit: hasAmount && fraction > 0 ? Math.round(rawAmount / fraction) : null,
        remainingFraction: fraction,
        resetTime: b.resetTime ?? null,
      };
    });

  return { tier, tierName, buckets, credits };
}

// ─── Generate Content (non-streaming) ───────────────────────────

export interface CloudCodeGenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Non-streaming generateContent via CloudCode with retry. Used by the indexer.
 */
export async function generateContent(
  authClient: OAuth2Client,
  projectId: string,
  model: string,
  systemInstruction: string,
  userContent: string,
  sessionId?: string,
): Promise<CloudCodeGenerateResult> {
  const sid = sessionId ?? randomUUID();
  return withRetry(async () => {
    const res = await authClient.request<{
      response?: {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
    }>({
      url: methodUrl('generateContent'),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent(model) },
      body: JSON.stringify({
        model,
        project: projectId,
        user_prompt_id: sid,
        request: {
          contents: [{ role: 'user', parts: [{ text: userContent }] }],
          systemInstruction: { parts: [{ text: systemInstruction }] },
          session_id: sid,
        },
      }),
    });

    const inner = res.data.response;
    const text = inner?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return {
      text,
      inputTokens: inner?.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: inner?.usageMetadata?.candidatesTokenCount ?? 0,
    };
  });
}

// ─── Stream Generate Content (SSE) ──────────────────────────────

export interface StreamChunk {
  text?: string;
  thought?: string;
  functionCall?: { id?: string; name: string; args: Record<string, unknown> };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  finishReason?: string;
}

/**
 * Streaming generateContent via CloudCode SSE with retry. Used by the coder.
 * Retry wraps the initial connection — once streaming starts, errors
 * propagate immediately (partial responses can't be replayed).
 */
export async function* streamGenerateContent(
  authClient: OAuth2Client,
  projectId: string,
  model: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
  sessionId?: string,
  thinkingEnabled?: boolean,
): AsyncIterable<StreamChunk> {
  const sid = sessionId ?? randomUUID();
  // Inject session_id + optional generationConfig into the request object
  const requestWithSession: Record<string, unknown> = {
    ...request,
    session_id: sid,
  };
  if (thinkingEnabled) {
    requestWithSession.generationConfig = {
      ...(request.generationConfig as Record<string, unknown> | undefined),
      thinkingConfig: { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_MODE },
    };
  }
  // ALWAYS inject thoughtSignature on functionCall parts — Gemini 3.x models
  // enable thinking by default even without thinkingConfig, and the API rejects
  // requests where function calls lack a signature. The synthetic value is
  // harmless when thinking isn't active (API ignores it).
  if (Array.isArray(requestWithSession.contents)) {
    requestWithSession.contents = ensureThoughtSignatures(
      requestWithSession.contents as unknown[],
    );
  }

  const res = await withRetry(
    () => authClient.request<NodeJS.ReadableStream>({
      url: methodUrl('streamGenerateContent'),
      method: 'POST',
      params: { alt: 'sse' },
      headers: { 'Content-Type': 'application/json', 'User-Agent': userAgent(model) },
      body: JSON.stringify({
        model,
        project: projectId,
        user_prompt_id: sid,
        request: requestWithSession,
      }),
      responseType: 'stream',
      signal,
    }),
    signal,
  );

  const stream = res.data;
  let buffer = '';

  for await (const rawChunk of stream as AsyncIterable<Buffer>) {
    buffer += rawChunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const json = line.slice(6).trim();
      if (!json || json === '[DONE]') continue;

      try {
        const event = JSON.parse(json) as {
          response?: {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string; thought?: boolean; functionCall?: unknown }> };
              finishReason?: string;
            }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
          };
        };

        const inner = event.response;
        const candidate = inner?.candidates?.[0];
        const parts = candidate?.content?.parts ?? [];

        for (const part of parts) {
          if (part.thought && typeof part.text === 'string' && part.text.length > 0) {
            // Thinking/reasoning text — emitted separately from normal text
            yield { thought: part.text };
          } else if (typeof part.text === 'string' && part.text.length > 0) {
            yield { text: part.text };
          }
          if (part.functionCall) {
            const fc = part.functionCall as { id?: string; name: string; args: Record<string, unknown> };
            yield { functionCall: fc };
          }
        }

        if (inner?.usageMetadata) {
          yield { usageMetadata: inner.usageMetadata };
        }
        if (candidate?.finishReason) {
          yield { finishReason: candidate.finishReason };
        }
      } catch {
        // Skip unparseable chunks
      }
    }
  }
}
