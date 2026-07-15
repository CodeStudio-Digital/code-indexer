/**
 * ChatGPT (Codex PKCE OAuth) chat adapter.
 *
 * Unlike the standard OpenAI adapter, the ChatGPT Codex backend only speaks
 * the Responses API (`POST /responses`, not `/chat/completions`). This
 * adapter is modeled after opencode's Codex plugin
 * (packages/opencode/src/plugin/codex.ts) and the official Codex CLI:
 *
 *   - baseURL:  https://chatgpt.com/backend-api/codex
 *   - endpoint: /responses (the OpenAI SDK appends this from responses.create)
 *   - auth:     Bearer <short-lived access_token>  (refreshed in the factory)
 *   - headers:  ChatGPT-Account-Id, originator, User-Agent, session_id
 *   - params:   no max_output_tokens (Codex rejects it)
 *
 * Stream event shapes come from the OpenAI SDK's responses API:
 *   - response.output_text.delta
 *   - response.output_item.added        (function_call or message items)
 *   - response.function_call_arguments.delta
 *   - response.function_call_arguments.done
 *   - response.completed                (carries usage)
 *
 * The adapter converts our canonical AgentMessage[] into the Responses API's
 * `input` array and emits our ChatDelta union as events stream in.
 */
import OpenAI from 'openai';
import { createHash, randomUUID } from 'node:crypto';
import { nativeFetch } from '@mcp/shared/utils/native-fetch.js';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { renderTextDocument, safeDocumentFilename } from './document-utils.js';

const GPT_56_PROMPT_CACHE_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
]);

// RFC 9562 UUID v5 uses SHA-1(namespace UUID + name). The fixed URL namespace
// keeps the transport header opaque while making it stable across provider
// recreation/resume for the same local coder session.
const CHATGPT_SESSION_UUID_NAMESPACE = Buffer.from(
  '6ba7b8119dad11d180b400c04fd430c8',
  'hex',
);

function transportSessionId(sessionId: string | number): string {
  const bytes = Buffer.from(
    createHash('sha1')
      .update(CHATGPT_SESSION_UUID_NAMESPACE)
      .update(`coder-session-${sessionId}`)
      .digest()
      .subarray(0, 16),
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Extract the chatgpt_account_id from an id_token JWT. Codex gates requests
 * on this header — without it, `/responses` returns 401 even with a valid
 * access token. Same logic as opencode's extractAccountIdFromClaims.
 */
export function extractAccountIdFromIdToken(idToken: string | undefined | null): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as {
      chatgpt_account_id?: string;
      organizations?: Array<{ id: string }>;
      'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
    };
    return (
      claims.chatgpt_account_id ??
      claims['https://api.openai.com/auth']?.chatgpt_account_id ??
      claims.organizations?.[0]?.id ??
      null
    );
  } catch {
    return null;
  }
}

export class ChatGPTCodexProvider implements ChatProvider {
  readonly name: string;
  model: string;
  private client: OpenAI;
  private sessionId: string;
  private reasoningCapability: {
    supported: string[] | null;
    default: string | null;
  } = { supported: null, default: null };
  /**
   * `provider_models.apply_patch_tool_type` for the active model. When
   * `'freeform'`, the chatgpt-bound `apply_patch` tool is sent as
   * `type: 'custom'` (no JSON schema) — the format the Codex backend prefers
   * for that variant. Any other value (including null) → function tool.
   */
  private applyPatchToolType: string | null = null;
  /**
   * When true, the chatgpt provider attaches the server-managed
   * `image_generation` tool to the request. Backend executes the generation
   * and streams the resulting image as an `image_generation_call` item; the
   * provider re-emits it as the `image_generated` ChatDelta.
   */
  private imageGenerationEnabled = false;
  /**
   * One-shot guard so the "temperature ignored by Codex Responses API" warning
   * fires once per provider instance, not on every turn.
   */
  private temperatureWarningEmitted = false;

  constructor(opts: {
    name?: string;
    apiKey: string;
    baseURL: string;
    model: string;
    accountId?: string | null;
    /** Optional. Pass the persisted `provider_models.supported_reasoning_levels`
     *  + `default_reasoning_level` so the provider can validate `req.thinking`
     *  against what the model actually supports. When omitted, no `reasoning`
     *  field is sent — backend falls back to the model default. */
    reasoning?: {
      supportedLevels?: string[] | null;
      defaultLevel?: string | null;
    };
    /** `provider_models.apply_patch_tool_type` for this model. When 'freeform',
     *  the `apply_patch` tool is sent as a custom (freeform) tool. */
    applyPatchToolType?: string | null;
    /** Attach the `image_generation` server-managed tool to every request.
     *  Gated by the factory to models that support it. */
    imageGenerationEnabled?: boolean;
  }) {
    this.name = opts.name ?? 'chatgpt';
    this.model = opts.model;
    this.sessionId = randomUUID();
    this.reasoningCapability = {
      supported: opts.reasoning?.supportedLevels ?? null,
      default: opts.reasoning?.defaultLevel ?? null,
    };
    this.applyPatchToolType = opts.applyPatchToolType ?? null;
    this.imageGenerationEnabled = opts.imageGenerationEnabled ?? false;

    const headers: Record<string, string> = {
      originator: 'codex_cli_rs',
      'User-Agent': 'codex_cli_rs/0.1.0',
      session_id: this.sessionId,
    };
    if (opts.accountId) headers['ChatGPT-Account-Id'] = opts.accountId;

    this.client = new OpenAI({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
      defaultHeaders: headers,
      // Use undici (native fetch) so installLlmDispatcher's bodyTimeout:0
      // applies during the reasoning phase. See native-fetch.ts.
      fetch: nativeFetch(),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  /**
   * Update reasoning capability post-construction. Useful when the factory
   * builds the provider before the DB row is hydrated (eg. fallback provider
   * factory). Pass null/undefined fields to clear.
   */
  setReasoningCapability(input: {
    supportedLevels?: string[] | null;
    defaultLevel?: string | null;
  }): void {
    this.reasoningCapability = {
      supported: input.supportedLevels ?? null,
      default: input.defaultLevel ?? null,
    };
  }

  /**
   * Map `req.thinking` to a reasoning effort level.
   * - thinking === true  → highest supported level (capped at 'high').
   * - thinking === false → 'minimal' if supported (saves output tokens).
   * - thinking unset     → null (let backend use the model default).
   */
  private pickReasoningEffort(thinking: boolean | undefined): string | null {
    if (thinking === undefined) return null;
    const supported = this.reasoningCapability.supported;
    const desired = thinking
      ? ['high', 'medium', 'low', 'minimal']
      : ['minimal', 'low', 'medium', 'high'];
    if (!supported || supported.length === 0) {
      // No capability info — send the desired top pick anyway. Models that
      // don't support `reasoning.effort` will reject; we accept that risk
      // because the unset default path stays available via thinking=undefined.
      return desired[0] ?? null;
    }
    return desired.find((level) => supported.includes(level)) ?? null;
  }

  /**
   * Resolve the effort to send, giving an explicit `req.reasoningEffort`
   * (composer/role override) precedence over the `thinking`-derived level.
   * The explicit value is only honoured when this model actually supports it
   * (or capability is unknown); an unsupported override degrades gracefully to
   * the derived behaviour rather than triggering a backend rejection.
   */
  private resolveReasoningEffort(req: ChatRequest): string | null {
    const explicit = req.reasoningEffort;
    if (explicit) {
      const supported = this.reasoningCapability.supported;
      if (!supported || supported.length === 0 || supported.includes(explicit)) {
        return explicit;
      }
    }
    return this.pickReasoningEffort(req.thinking);
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    // The Codex Responses API does not honor `temperature` (the model uses
    // `reasoning.effort` to control variability). When the runner resolves a
    // temperature for a Codex session, log a one-shot warning so the user
    // doesn't wonder why their override has no effect.
    if (
      typeof req.inference?.temperature === 'number' &&
      !this.temperatureWarningEmitted
    ) {
      this.temperatureWarningEmitted = true;
      console.warn(
        `[chatgpt] temperature=${req.inference.temperature} ignored — Codex Responses API does not accept the parameter. Use reasoning.effort (req.thinking) instead.`,
      );
    }

    // store/previous_response_id is opt-in via CODEX_STORE_RESPONSES=1.
    // The chatgpt.com OAuth backend often rejects or silently drops these
    // (the official Codex CLI only sets store:true for Azure Responses).
    // Defaulting off keeps behaviour aligned with that reference impl.
    const wantStore = process.env.CODEX_STORE_RESPONSES === '1';

    // When `previousResponseId` is set AND store is on, the backend already
    // has the prefix up to `previousResponseMessageCount` — ship only the
    // new messages. Otherwise send the full transcript every turn.
    const useResume = wantStore && !!req.previousResponseId;
    const messagesToSend = useResume
      ? req.messages.slice(req.previousResponseMessageCount ?? 0)
      : req.messages;
    const input = toResponsesInput(messagesToSend);
    const totalMessageCount = req.messages.length;

    const wantFreeformPatch = this.applyPatchToolType === 'freeform';
    const tools: Array<Record<string, unknown>> = req.tools.map((t) => {
      if (t.name === 'apply_patch' && wantFreeformPatch) {
        // Custom (freeform) tool: backend treats `description` as the
        // grammar prompt and emits `custom_tool_call` items with raw input.
        // We strip the JSON schema so the model emits patch text directly.
        return {
          type: 'custom' as const,
          name: t.name,
          description: t.description,
        };
      }
      return {
        type: 'function' as const,
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
        strict: false,
      };
    });
    if (this.imageGenerationEnabled) {
      // Server-managed: backend executes the generation and streams the
      // resulting image. No client-side handler is required beyond consuming
      // the `image_generation_call` output_item.
      tools.push({ type: 'image_generation', output_format: 'png' });
    }

    // The SDK's responses.create is typed loosely; cast through unknown to
    // avoid version-skew compile errors on the experimental shape. Runtime
    // behavior is what matters — Codex accepts the stable shape below.
    //
    // Effort resolution: an EXPLICIT `req.reasoningEffort` (composer/role
    // override) wins over the `thinking`-derived level — these are orthogonal
    // (e.g. thinking ON + effort 'xhigh'). We only honour the explicit value
    // when the model supports it (or capability is unknown); otherwise we fall
    // back to the derived behaviour so an invalid override never breaks a turn.
    const reasoningEffort = this.resolveReasoningEffort(req);
    const promptCacheKey =
      req.sessionId != null && GPT_56_PROMPT_CACHE_MODELS.has(this.model.toLowerCase())
        ? `coder-session-${req.sessionId}`
        : null;
    const stableTransportSessionId =
      req.sessionId != null ? transportSessionId(req.sessionId) : null;

    const stream = (await (this.client as unknown as {
      responses: {
        create: (
          args: Record<string, unknown>,
          opts?: { signal?: AbortSignal; headers?: Record<string, string> },
        ) => Promise<AsyncIterable<Record<string, unknown>>>;
      };
    }).responses.create(
      {
        model: this.model,
        instructions: req.system,
        input,
        ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
        ...(tools.length > 0 ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
        stream: true,
        // store: opt-in. When CODEX_STORE_RESPONSES=1 we persist server-side
        // and replay `previous_response_id` next turn for ~40-80% better
        // cache utilization. Default off — the OAuth backend isn't documented
        // to support this and we observed silent failures with store=true.
        store: wantStore,
        ...(useResume ? { previous_response_id: req.previousResponseId } : {}),
        // Reasoning effort is only sent when the runner explicitly opted in
        // via `req.thinking`. When undefined we omit the field so the backend
        // applies the model's default level (e.g. 'medium' for gpt-5.5).
        // `summary: 'auto'` requests reasoning summary deltas the user can read.
        ...(reasoningEffort
          ? { reasoning: { effort: reasoningEffort, summary: 'auto' } }
          : {}),
      },
      // Forward the AbortSignal so the SDK can tear down the underlying
      // fetch when the runner aborts (e.g. user-initiated cancellation
      // or an internal timeout). Without this, an idle stream can wedge
      // for the full HTTP read timeout.
      req.signal || stableTransportSessionId
        ? {
            ...(req.signal ? { signal: req.signal } : {}),
            ...(stableTransportSessionId
              ? { headers: { session_id: stableTransportSessionId } }
              : {}),
          }
        : undefined,
    )) as AsyncIterable<Record<string, unknown>>;

    // Track tool calls across streaming events. Keyed by item_id because
    // the Responses API reports args deltas with the item_id, not an index.
    const toolAcc = new Map<
      string,
      { call_id: string; name: string; argsAcc: string; emittedStart: boolean }
    >();

    for await (const evt of stream) {
      const type = evt.type as string | undefined;
      if (!type) continue;

      // Incremental text from the assistant message.
      if (type === 'response.output_text.delta') {
        const delta = evt.delta as string | undefined;
        if (delta) yield { type: 'text_delta', text: delta };
        continue;
      }

      // Reasoning deltas — GPT-5+ models emit a `reasoning` output item
      // before/instead of plain text. We surface the text via the
      // `thinking_delta` channel (same one used by Anthropic extended
      // thinking and Gemini thinkingConfig) so the dashboard renders it
      // in the existing reasoning UI.
      if (
        type === 'response.reasoning_text.delta' ||
        type === 'response.reasoning_summary_text.delta'
      ) {
        const delta = evt.delta as string | undefined;
        if (delta) yield { type: 'thinking_delta', text: delta };
        continue;
      }
      // Boundary markers — useful telemetry but no payload to emit.
      if (
        type === 'response.reasoning_summary_part.added' ||
        type === 'response.reasoning_part.added'
      ) {
        continue;
      }

      // A new output item appeared. We use this only to seed the tool
      // accumulator and emit `tool_call_start` early so the UI can show
      // "calling X" while args are still streaming. The authoritative
      // payload (with final arguments) arrives at `output_item.done`.
      if (type === 'response.output_item.added') {
        const item = evt.item as
          | { type: string; id?: string; call_id?: string; name?: string }
          | undefined;
        if ((item?.type === 'function_call' || item?.type === 'custom_tool_call') && item.id) {
          toolAcc.set(item.id, {
            call_id: item.call_id ?? item.id,
            name: item.name ?? '',
            argsAcc: '',
            emittedStart: false,
          });
          if (item.name) {
            toolAcc.get(item.id)!.emittedStart = true;
            yield { type: 'tool_call_start', id: item.call_id ?? item.id, name: item.name };
          }
        }
        continue;
      }

      // Partial JSON arguments for a function_call (function tool variant).
      if (type === 'response.function_call_arguments.delta') {
        const itemId = evt.item_id as string | undefined;
        const delta = evt.delta as string | undefined;
        if (!itemId || !delta) continue;
        const acc = toolAcc.get(itemId);
        if (!acc) continue;
        acc.argsAcc += delta;
        if (!acc.emittedStart && acc.name) {
          acc.emittedStart = true;
          yield { type: 'tool_call_start', id: acc.call_id, name: acc.name };
        }
        yield { type: 'tool_call_args', id: acc.call_id, partial_json: delta };
        continue;
      }

      // Partial input for custom (freeform) tools — emitted instead of
      // function_call_arguments.* when the tool was registered with
      // `apply_patch_tool_type: 'freeform'` or `type: 'custom'`.
      if (type === 'response.custom_tool_call_input.delta') {
        const itemId = (evt.item_id as string | undefined) ?? (evt.call_id as string | undefined);
        const delta = evt.delta as string | undefined;
        if (!itemId || !delta) continue;
        const acc = toolAcc.get(itemId);
        if (!acc) continue;
        acc.argsAcc += delta;
        if (!acc.emittedStart && acc.name) {
          acc.emittedStart = true;
          yield { type: 'tool_call_start', id: acc.call_id, name: acc.name };
        }
        yield { type: 'tool_call_args', id: acc.call_id, partial_json: delta };
        continue;
      }

      // Authoritative end-of-item event. Carries the FULL `arguments`
      // string for function_call items (and full `input` for custom
      // tools). Modern Codex backends (gpt-5.x) frequently emit args
      // ONLY here — the `function_call_arguments.delta/done` stream is
      // not always fired. Treating this as the source of truth (with
      // delta-streamed args as a hint for incremental UI) is what the
      // official Codex CLI does too — see
      // codex-rs/codex-api/src/sse/responses.rs::process_responses_event.
      if (type === 'response.output_item.done') {
        const item = evt.item as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              name?: string;
              arguments?: string;
              input?: string;
              status?: string;
              result?: string;
              revised_prompt?: string;
            }
          | undefined;
        if (!item || !item.id) continue;
        // Server-managed image generation result.
        if (item.type === 'image_generation_call' && item.result) {
          // `result` is base64-encoded PNG when output_format='png'. Some
          // backends return a data URL — strip the prefix if present.
          const m = /^data:(image\/[^;]+);base64,(.*)$/.exec(item.result);
          const mediaType = m ? m[1] : 'image/png';
          const base64 = m ? m[2] : item.result;
          yield {
            type: 'image_generated',
            id: item.id,
            mediaType,
            base64,
            revisedPrompt: item.revised_prompt,
          };
          continue;
        }
        const isFn = item.type === 'function_call';
        const isCustom = item.type === 'custom_tool_call';
        if (!isFn && !isCustom) continue;

        const acc = toolAcc.get(item.id);
        if (!acc) {
          // Already flushed by `function_call_arguments.done` for the
          // same item_id — dedupe to avoid emitting the tool twice.
          continue;
        }

        const callId = item.call_id ?? acc.call_id;
        const name = item.name ?? acc.name;
        // Custom (freeform) tools carry the raw input string verbatim — do
        // NOT trim or parse it (callers may rely on trailing newlines, eg.
        // apply_patch). Function tools carry a JSON `arguments` string.
        const argsStr = isCustom
          ? (item.input ?? acc.argsAcc ?? '')
          : (item.arguments ?? acc.argsAcc ?? '').trim();

        let parsed: Record<string, unknown> = {};
        if (argsStr) {
          if (isCustom) {
            parsed = { _raw: argsStr };
          } else {
            try {
              parsed = JSON.parse(argsStr) as Record<string, unknown>;
            } catch {
              parsed = { _raw: argsStr };
            }
          }
        }

        if (!acc.emittedStart && name) {
          yield { type: 'tool_call_start', id: callId, name };
        }
        yield { type: 'tool_call_end', id: callId, name, input: parsed };
        toolAcc.delete(item.id);
        continue;
      }

      // Final args payload (also contains .arguments string). When this
      // event arrives we already streamed the deltas; use it as the
      // cue to flush an early tool_call_end. If `output_item.done`
      // already removed the entry, we simply skip — that's the
      // happy path on modern Codex.
      if (type === 'response.function_call_arguments.done') {
        const itemId = evt.item_id as string | undefined;
        if (!itemId) continue;
        const acc = toolAcc.get(itemId);
        if (!acc) continue;
        const argsStr = ((evt.arguments as string | undefined) ?? acc.argsAcc).trim();
        let parsed: Record<string, unknown> = {};
        if (argsStr) {
          try {
            parsed = JSON.parse(argsStr) as Record<string, unknown>;
          } catch {
            parsed = { _raw: argsStr };
          }
        }
        yield { type: 'tool_call_end', id: acc.call_id, name: acc.name, input: parsed };
        toolAcc.delete(itemId);
        continue;
      }

      // Terminal event — emit usage + done. Flush any tool_call still
      // pending (no .done and no .output_item.done arrived for it) so
      // the runner sees a complete tool_use block instead of silently
      // dropping it.
      if (type === 'response.completed') {
        for (const [, acc] of toolAcc) {
          if (!acc.name) continue;
          let parsed: Record<string, unknown> = {};
          const argsStr = acc.argsAcc.trim();
          if (argsStr) {
            try {
              parsed = JSON.parse(argsStr) as Record<string, unknown>;
            } catch {
              parsed = { _raw: argsStr };
            }
          }
          if (!acc.emittedStart) {
            yield { type: 'tool_call_start', id: acc.call_id, name: acc.name };
          }
          yield { type: 'tool_call_end', id: acc.call_id, name: acc.name, input: parsed };
        }
        toolAcc.clear();

        const response = evt.response as
          | {
              id?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_tokens_details?: {
                  cached_tokens?: number;
                  cache_write_tokens?: number;
                };
              };
              status?: string;
            }
          | undefined;
        // Only surface the response id when store is enabled — otherwise
        // there's nothing for the next turn to replay against.
        if (wantStore && response?.id) {
          yield {
            type: 'response_id',
            id: response.id,
            messageCount: totalMessageCount,
          };
        }
        const u = response?.usage;
        if (u) {
          const inputTokens = u.input_tokens ?? 0;
          const cachedTokens = u.input_tokens_details?.cached_tokens ?? 0;
          const cacheWriteTokens = u.input_tokens_details?.cache_write_tokens ?? 0;
          if (inputTokens > 0) {
            const ratio = Math.round((cachedTokens / inputTokens) * 100);
            console.log(
              `[chatgpt] turn cache: input=${inputTokens} cached=${cachedTokens} written=${cacheWriteTokens} ratio=${ratio}% model=${this.model}`,
            );
          }
          yield {
            type: 'usage',
            usage: {
              input_tokens: inputTokens,
              output_tokens: u.output_tokens ?? 0,
              cache_read_input_tokens: cachedTokens,
              cache_creation_input_tokens: cacheWriteTokens,
              // Responses API: input_tokens already INCLUDES cached tokens.
              prompt_tokens_total: inputTokens,
            },
          };
        }
        yield { type: 'done', stop_reason: response?.status ?? 'completed' };
        continue;
      }

      // Failure modes surface as response.error or response.failed.
      if (type === 'response.error' || type === 'response.failed') {
        const err = (evt.error ?? (evt.response as { error?: unknown })?.error) as
          | { message?: string }
          | undefined;
        throw new Error(`Codex responses error: ${err?.message ?? JSON.stringify(evt)}`);
      }
    }
  }
}

// ─── Message conversion (AgentMessage → Responses `input`) ─────

type ResponsesInputItem =
  | {
      role: 'user' | 'assistant' | 'system' | 'developer';
      content: Array<
        | { type: 'input_text'; text: string }
        | { type: 'output_text'; text: string }
        | { type: 'input_image'; image_url: string }
        | { type: 'input_file'; filename: string; file_data: string; detail?: 'auto' | 'low' | 'high' }
      >;
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export function toResponsesInput(messages: AgentMessage[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      // Each tool_result → function_call_output item.
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        out.push({
          type: 'function_call_output',
          call_id: b.tool_use_id,
          output: b.content,
        });
      }
      continue;
    }

    if (m.role === 'user') {
      const parts: Array<
        | { type: 'input_text'; text: string }
        | { type: 'input_image'; image_url: string }
        | { type: 'input_file'; filename: string; file_data: string; detail?: 'auto' | 'low' | 'high' }
      > = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) {
          parts.push({ type: 'input_text', text: b.text });
        } else if (b.type === 'image') {
          parts.push({
            type: 'input_image',
            image_url: `data:${b.mediaType};base64,${b.base64}`,
          });
        } else if (b.type === 'document' && b.base64) {
          parts.push({
            type: 'input_file',
            filename: safeDocumentFilename(b),
            file_data: `data:${b.mediaType};base64,${b.base64}`,
            ...(b.mediaType === 'application/pdf' ? { detail: 'auto' as const } : {}),
          });
        } else if (b.type === 'document' && b.text) {
          parts.push({
            type: 'input_text',
            text: renderTextDocument(b),
          });
        }
      }
      const toolResults = m.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result'
      );
      if (parts.length > 0) {
        out.push({ role: 'user', content: parts });
      }
      for (const tr of toolResults) {
        out.push({
          type: 'function_call_output',
          call_id: tr.tool_use_id,
          output: tr.content,
        });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (text) {
        out.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      const toolUses = m.content.filter(
        (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use'
      );
      for (const tu of toolUses) {
        out.push({
          type: 'function_call',
          call_id: tu.id,
          name: tu.name,
          arguments: JSON.stringify(tu.input),
        });
      }
      continue;
    }
  }

  return out;
}
