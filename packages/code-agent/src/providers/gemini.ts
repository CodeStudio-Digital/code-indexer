import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { Content, Part, Tool, FunctionDeclaration, ThinkingConfig } from '@google/genai';
import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { renderTextDocument } from './document-utils.js';
import { randomUUID } from 'node:crypto';
import {
  createAuthClient,
  streamGenerateContent as cloudCodeStream,
  DEFAULT_THINKING_MODE,
  type StreamChunk,
} from '@mcp/services/services/cloudcode.js';

/**
 * Native Gemini chat adapter built on @google/genai (the unified SDK that
 * replaced @google/generative-ai). Streams text + function calls and exposes
 * cache/thinking token usage via GenerateContentResponseUsageMetadata.
 *
 * Why native instead of the OpenAI-compat shim at /v1beta/openai/:
 *   - thinking_config, context caching, and first-party function calling
 *     are only reachable through the native contents/tools schema.
 *   - response_schema and safety settings differ between the shim and native.
 *   - The SDK handles streaming backpressure and abort signalling natively.
 *
 * Mapping overview:
 *   AgentMessage (normalized)        ↔ Content[] with Part[]
 *     user text/image                → {text} / {inlineData: {mimeType, data}}
 *     assistant text                 → {text}
 *     assistant tool_use             → {functionCall: {id, name, args}}
 *     tool tool_result               → user role + {functionResponse}
 *   ToolSpec                         ↔ FunctionDeclaration
 */
export class GeminiChatProvider implements ChatProvider {
  readonly inferenceOnly = true; // Function declarations only; no hosted code/search tools.
  readonly name = 'gemini';
  model: string;
  private client: GoogleGenAI | null = null;
  /** CloudCode OAuth mode (mirrors gemini-cli "Login with Google"). */
  private cloudCode: {
    authClient: ReturnType<typeof createAuthClient>;
    projectId: string;
    sessionId: string;
  } | null = null;

  constructor(opts: {
    apiKey?: string;
    accessToken?: string;
    refreshToken?: string | null;
    projectId?: string;
    cloudCodeSessionId?: string;
    model?: string;
  }) {
    this.model = opts.model ?? 'gemini-3.6-flash';
    if (opts.accessToken) {
      // OAuth mode: route through CloudCode (cloudcode-pa.googleapis.com)
      // like the Gemini CLI does. generativelanguage.googleapis.com does NOT
      // accept cloud-platform scoped tokens.
      // sessionId is persisted in the bundle state so it
      // survives reconnects and resume — same as gemini-cli's module-level UUID.
      this.cloudCode = {
        authClient: createAuthClient(opts.accessToken, opts.refreshToken),
        projectId: opts.projectId ?? '',
        sessionId: opts.cloudCodeSessionId ?? randomUUID(),
      };
    } else {
      const apiKey = opts.apiKey;
      if (!apiKey) {
        throw new Error('Gemini API key not set — configure the provider via the admin UI');
      }
      this.client = new GoogleGenAI({ apiKey });
    }
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    // CloudCode path — route through cloudcode-pa.googleapis.com like gemini-cli.
    if (this.cloudCode) {
      yield* this.chatViaCloudCode(req);
      return;
    }

    const contents = toGeminiContents(req.messages);
    const tools: Tool[] | undefined = req.tools.length > 0
      ? [
          {
            functionDeclarations: req.tools.map(
              (t): FunctionDeclaration => ({
                name: sanitizeToolName(t.name),
                description: t.description,
                parametersJsonSchema: sanitizeSchemaForGemini(t.parameters) as unknown,
              })
            ),
          },
        ]
      : undefined;

    const temperature = req.inference?.temperature;
    const thinkingConfig = resolveGeminiThinkingConfig(this.model, req);

    let stream;
    try {
      stream = await this.client!.models.generateContentStream({
        model: this.model,
        contents,
        config: {
          systemInstruction: req.system,
          tools,
          abortSignal: req.signal,
          ...(typeof temperature === 'number' ? { temperature } : {}),
          ...(thinkingConfig ? { thinkingConfig } : {}),
        },
      });
    } catch (e) {
      throw new Error(humanizeGeminiError(e, this.model));
    }

    // Gemini emits complete function calls per chunk (no partial-json streaming
    // the way OpenAI does). We still emit tool_call_start + tool_call_args +
    // tool_call_end so the runner's bookkeeping stays uniform across providers.
    let lastUsage: { input: number; output: number; cachedRead: number; thinking: number } | null = null;
    let finishReason: string | undefined;
    let receivedTerminal = false;

    try {
    for await (const chunk of stream) {
      const candidate = chunk.candidates?.[0];
      const parts: Part[] = candidate?.content?.parts ?? [];

      for (const part of parts) {
        if (part.thought && typeof part.text === 'string' && part.text.length > 0) {
          yield { type: 'thinking_delta', text: part.text };
          continue;
        }
        if (typeof part.text === 'string' && part.text.length > 0) {
          yield { type: 'text_delta', text: part.text };
        }
        if (part.functionCall) {
          const fc = part.functionCall;
          const id = fc.id ?? `gemini_${Math.random().toString(36).slice(2, 10)}`;
          const name = fc.name ?? 'unknown';
          const input = (fc.args ?? {}) as Record<string, unknown>;
          yield { type: 'tool_call_start', id, name };
          yield { type: 'tool_call_args', id, partial_json: JSON.stringify(input) };
          yield { type: 'tool_call_end', id, name, input };
        }
      }

      if (chunk.usageMetadata) {
        lastUsage = {
          input: chunk.usageMetadata.promptTokenCount ?? 0,
          output: chunk.usageMetadata.candidatesTokenCount ?? 0,
          cachedRead: chunk.usageMetadata.cachedContentTokenCount ?? 0,
          thinking: chunk.usageMetadata.thoughtsTokenCount ?? 0,
        };
      }
      if (candidate?.finishReason != null) {
        finishReason = String(candidate.finishReason);
        receivedTerminal = true;
      }
    }

    if (lastUsage) {
      yield {
        type: 'usage',
        usage: {
          input_tokens: lastUsage.input,
          output_tokens: lastUsage.output,
          cache_read_input_tokens: lastUsage.cachedRead,
          // Gemini: promptTokenCount already INCLUDES cached content tokens.
          prompt_tokens_total: lastUsage.input,
          thinking_tokens: lastUsage.thinking || undefined,
        },
      };
    }
    // EOF alone is not a successful Gemini response. The runner turns a
    // stream without this native candidate finish marker into
    // `stream_ended_no_result`, preserving a truncated physical attempt.
    if (receivedTerminal) {
      yield { type: 'done', stop_reason: finishReason };
    }
    } catch (e) {
      throw new Error(humanizeGeminiError(e, this.model));
    }
  }

  /**
   * Stream via CloudCode (cloudcode-pa.googleapis.com) — the same backend
   * the Gemini CLI uses for OAuth. Translates the CloudCode SSE stream into
   * the normalized ChatDelta shape the runner expects.
   */
  private async *chatViaCloudCode(req: ChatRequest): AsyncIterable<ChatDelta> {
    const cc = this.cloudCode!;
    const contents = toGeminiContents(req.messages);

    const tools = req.tools.length > 0
      ? [{
          functionDeclarations: req.tools.map((t) => ({
            name: sanitizeToolName(t.name),
            description: t.description,
            parameters: sanitizeSchemaForGemini(t.parameters),
          })),
        }]
      : undefined;

    const ccTemperature = req.inference?.temperature;
    const ccThinkingConfig = resolveGeminiThinkingConfig(this.model, req);
    const generationConfig = {
      ...(typeof ccTemperature === 'number' ? { temperature: ccTemperature } : {}),
      ...(ccThinkingConfig ? { thinkingConfig: ccThinkingConfig } : {}),
    };
    const request = {
      contents,
      systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
      tools,
      ...(Object.keys(generationConfig).length > 0
        ? { generationConfig }
        : {}),
    };

    let lastUsage: { input: number; output: number; thinking: number } | null = null;
    let finishReason: string | undefined;
    let receivedTerminal = false;

    try {
      for await (const chunk of cloudCodeStream(
        cc.authClient,
        cc.projectId,
        this.model,
        request,
        req.signal,
        cc.sessionId,
        // The model-specific config is already present in generationConfig;
        // do not let the legacy CloudCode boolean shim overwrite it.
        undefined,
        1,
      )) {
        if (chunk.thought) {
          yield { type: 'thinking_delta', text: chunk.thought };
        }
        if (chunk.text) {
          yield { type: 'text_delta', text: chunk.text };
        }
        if (chunk.functionCall) {
          const fc = chunk.functionCall;
          const id = fc.id ?? `gemini_${Math.random().toString(36).slice(2, 10)}`;
          const name = fc.name ?? 'unknown';
          const input = (fc.args ?? {}) as Record<string, unknown>;
          yield { type: 'tool_call_start', id, name };
          yield { type: 'tool_call_args', id, partial_json: JSON.stringify(input) };
          yield { type: 'tool_call_end', id, name, input };
        }
        if (chunk.usageMetadata) {
          lastUsage = {
            input: chunk.usageMetadata.promptTokenCount ?? 0,
            output: chunk.usageMetadata.candidatesTokenCount ?? 0,
            thinking: chunk.usageMetadata.thoughtsTokenCount ?? 0,
          };
        }
        if (chunk.finishReason != null) {
          finishReason = chunk.finishReason;
          receivedTerminal = true;
        }
      }
    } catch (e) {
      throw new Error(humanizeGeminiError(e, this.model));
    }

    if (lastUsage) {
      yield {
        type: 'usage',
        usage: {
          input_tokens: lastUsage.input,
          output_tokens: lastUsage.output,
          cache_read_input_tokens: 0,
          // Gemini: promptTokenCount is the full prompt (no cache split here).
          prompt_tokens_total: lastUsage.input,
          thinking_tokens: lastUsage.thinking || undefined,
        },
      };
    }
    // CloudCode can close its SSE iterator without a terminal candidate.
    // Do not convert that transport EOF into a successful logical result.
    if (receivedTerminal) {
      yield { type: 'done', stop_reason: finishReason };
    }
  }
}

/**
 * The @google/genai SDK throws errors whose .message is the raw JSON body
 * from the API — a 2KB wall of text with error.code, error.message nested
 * inside, plus quotaFailure details. Users saw this and had no idea what
 * failed. Extract the actionable fields and return a short human line, or
 * fall back to the original message if parsing fails.
 */
/**
 * Sanitize a JSON Schema so Gemini's `parametersJsonSchema` accepts it.
 *
 * Known Gemini restrictions (from field tests, not documented exhaustively):
 *   - `type: "integer"` is rejected — use "number".
 *   - `type: ["string", "null"]` (nullable arrays) is rejected — pick the
 *     non-null type and set `nullable: true`.
 *   - `$ref`, `$defs`, `definitions`, `$schema`, `$id` are rejected.
 *   - Some `format` values cause validation errors — drop unknown ones.
 *   - `additionalProperties` as a schema (vs a boolean) is rejected.
 *   - `exclusiveMinimum`/`exclusiveMaximum` as booleans (Draft 4) differ from
 *     numeric form (2020-12); Gemini prefers the numeric form.
 *   - Deeply recursive schemas via `$ref` cycles need to be flattened.
 *
 * We recurse into `properties`, `items`, `oneOf`, `anyOf`, `allOf`,
 * `prefixItems`. Anything unknown is preserved — most harmless metadata
 * (title, description, default, enum) passes through fine.
 */
function sanitizeSchemaForGemini(schema: unknown): unknown {
  if (schema === null || schema === undefined) return schema;
  if (Array.isArray(schema)) return schema.map((s) => sanitizeSchemaForGemini(s));
  if (typeof schema !== 'object') return schema;

  const src = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  // Drop keys Gemini never accepts.
  const DROP = new Set([
    '$ref',
    '$defs',
    'definitions',
    '$schema',
    '$id',
    '$comment',
    'patternProperties',
    'propertyNames',
    'unevaluatedProperties',
    'unevaluatedItems',
    'dependentSchemas',
    'dependentRequired',
    'if',
    'then',
    'else',
  ]);

  for (const [key, value] of Object.entries(src)) {
    if (DROP.has(key)) continue;

    if (key === 'type') {
      // `integer` → `number` (Gemini rejects integer).
      if (value === 'integer') {
        out.type = 'number';
        continue;
      }
      // Nullable type arrays → pick the non-null and mark nullable.
      if (Array.isArray(value)) {
        const types = value.filter((t) => t !== 'null') as string[];
        const hasNull = (value as unknown[]).includes('null');
        if (types.length === 1) {
          out.type = types[0] === 'integer' ? 'number' : types[0];
          if (hasNull) out.nullable = true;
        } else if (types.length > 1) {
          // Multi-type union (e.g. string|number): degrade to string since
          // Gemini's schema doesn't express unions outside of anyOf. Safer
          // to be permissive than to lose the parameter entirely.
          out.type = 'string';
        }
        continue;
      }
      out.type = value;
      continue;
    }

    if (key === 'properties' && typeof value === 'object' && value !== null) {
      const props: Record<string, unknown> = {};
      for (const [pk, pv] of Object.entries(value as Record<string, unknown>)) {
        props[pk] = sanitizeSchemaForGemini(pv);
      }
      out.properties = props;
      continue;
    }

    if (key === 'items' || key === 'contains' || key === 'not') {
      out[key] = sanitizeSchemaForGemini(value);
      continue;
    }

    if (key === 'additionalProperties') {
      // Only boolean form is safe. A schema form is dropped entirely.
      if (typeof value === 'boolean') out[key] = value;
      continue;
    }

    if (key === 'oneOf' || key === 'anyOf' || key === 'allOf' || key === 'prefixItems') {
      if (Array.isArray(value)) {
        out[key] = value.map((s) => sanitizeSchemaForGemini(s));
      }
      continue;
    }

    if (key === 'format') {
      // Only keep formats Gemini understands. The rest are metadata and
      // safe to drop; real validation happens at the tool handler anyway.
      const KEEP_FORMATS = new Set(['date-time', 'date', 'time', 'enum']);
      if (typeof value === 'string' && KEEP_FORMATS.has(value)) out.format = value;
      continue;
    }

    out[key] = value;
  }

  // A bare schema with no type defaults to object — some MCP tools omit it.
  if (!('type' in out) && 'properties' in out) {
    out.type = 'object';
  }

  return out;
}

/**
 * Gemini tool names must be ≤64 chars and match [a-zA-Z0-9_.:-]+. MCP bridge
 * tools often exceed this (e.g. `mcp__3a9a552e-fad2-45e1-88fb-c0dd0a03171b__search_cloudflare_documentation`).
 * We strip invalid chars, truncate to 64, and prefer the tail of the name
 * because MCP prefixes are usually the redundant part.
 */
function sanitizeToolName(name: string): string {
  let cleaned = name.replace(/[^a-zA-Z0-9_.:-]/g, '_');
  if (cleaned.length > 64) {
    // Keep the last 64 chars — the distinctive suffix.
    cleaned = cleaned.slice(cleaned.length - 64);
    // Ensure we don't start with something Gemini might reject.
    if (!/^[a-zA-Z_]/.test(cleaned)) cleaned = 'f_' + cleaned.slice(2);
  }
  return cleaned;
}

function humanizeGeminiError(e: unknown, model: string): string {
  const raw = e instanceof Error ? e.message : String(e);
  try {
    // The SDK wraps the body in `{"error": {...}}`; sometimes there's leading
    // text before the JSON. Find the first `{` and parse from there.
    const jsonStart = raw.indexOf('{');
    if (jsonStart === -1) return raw;
    const parsed = JSON.parse(raw.slice(jsonStart)) as {
      error?: { code?: number; status?: string; message?: string };
    };
    // The SDK double-wraps: outer {error:{message: "<inner JSON string>"}}.
    // Unwrap once more when message itself parses as another error envelope.
    let err = parsed.error ?? {};
    if (typeof err.message === 'string' && err.message.trim().startsWith('{')) {
      try {
        const inner = JSON.parse(err.message) as { error?: typeof err };
        if (inner.error) err = { ...err, ...inner.error };
      } catch {
        /* keep outer */
      }
    }
    if (!err.code && !err.message) return raw;
    const code = err.code ?? '?';
    const status = err.status ?? '';
    // Trim the first sentence of the message (API returns a long multiline blob).
    const firstLine = (err.message ?? '').split('\n')[0].trim();
    if (code === 429 || status === 'RESOURCE_EXHAUSTED') {
      return (
        `Gemini quota exceeded for model "${model}" (free tier limit reached or billing not enabled). ` +
        `Enable billing at https://aistudio.google.com/app/apikey or switch to a model with quota. ` +
        `Details: ${firstLine}`
      );
    }
    if (code === 400 || status === 'INVALID_ARGUMENT') {
      // First: the single most common cause of a generic 400 with no
      // fieldViolations is an unknown model id. Detect it via a known-good
      // prefix check — Gemini's current public models all start with
      // `gemini-1.5-`, `gemini-2.0-`, or `gemini-2.5-`.
      const KNOWN_PREFIXES = [
        'gemini-1.5-',
        'gemini-2.0-',
        'gemini-2.5-',
        'gemini-3-',
        'gemini-3.1-',
        'gemini-3.5-',
        'gemini-3.6-',
        'gemini-embedding',
      ];
      const looksLikeUnknownModel = !KNOWN_PREFIXES.some((p) => model.startsWith(p));
      if (looksLikeUnknownModel) {
        return (
          `Gemini rejected model id "${model}" — this model does not exist in the Gemini API. ` +
          `Valid public models include gemini-3.6-flash, gemini-3.5-flash, ` +
          `gemini-3.1-pro, and gemini-3.1-flash-lite. ` +
          `If you expected it to exist, run "Refresh models" in the admin to pull the live list.`
        );
      }

      // Try to pull fieldViolations out of error.details[]. Different API
      // versions put them at different nesting depths.
      const details = (err as { details?: unknown[] }).details ?? [];
      const violations: string[] = [];
      for (const d of details) {
        const obj = d as {
          fieldViolations?: Array<{ field?: string; description?: string }>;
          '@type'?: string;
        };
        if (Array.isArray(obj.fieldViolations)) {
          for (const v of obj.fieldViolations) {
            violations.push(`${v.field ?? '?'}: ${v.description ?? ''}`.trim());
          }
        }
      }

      if (violations.length > 0) {
        return (
          `Gemini rejected the request for "${model}" (400 INVALID_ARGUMENT). ` +
          `Tool schema violation: ${violations.join('; ')}`
        );
      }

      // No structured violations — surface the raw error body (minus our
      // own wrapper envelope) so the user has SOMETHING to act on. The SDK
      // error body is the full API response as a string; truncate to keep
      // the UI banner readable.
      const rawBody = raw.length > 600 ? raw.slice(0, 600) + '…' : raw;
      return (
        `Gemini rejected the request for "${model}" (400 INVALID_ARGUMENT) with no field-level detail. ` +
        `Common causes: (a) the model id doesn't exist or isn't enabled on your key, ` +
        `(b) a tool schema has an unsupported feature, (c) contents array is empty. ` +
        `Raw response: ${rawBody}`
      );
    }
    return `Gemini API ${code} ${status}: ${firstLine}`;
  } catch {
    return raw;
  }
}

/**
 * Translate the product's normalized effort/toggle into the model-specific
 * Gemini API control. Gemini 3+ uses discrete thinkingLevel values; Gemini 2.5
 * keeps the legacy token-budget contract.
 */
export function resolveGeminiThinkingConfig(
  model: string,
  req: Pick<ChatRequest, 'thinking' | 'thinkingBudgetTokens' | 'reasoningEffort'>,
): ThinkingConfig | undefined {
  const family = model.toLowerCase();
  const requested = req.reasoningEffort?.trim().toLowerCase();
  const wantsVisibleThoughts =
    req.thinking === true || (requested != null && requested !== '' && requested !== 'none');

  if (/^gemini-3(?:[.\-]|$)/.test(family)) {
    const supported = gemini3SupportedLevels(family);
    const level = normalizeGemini3Level(requested, supported)
      ?? (req.thinking === false ? supported[0] : null);
    if (!level && req.thinking === undefined) return undefined;
    return {
      includeThoughts: wantsVisibleThoughts,
      ...(level ? { thinkingLevel: level } : {}),
    };
  }

  if (/^gemini-2\.5-/.test(family)) {
    const isPro = family.includes('pro');
    const maxBudget = isPro ? 32_768 : 24_576;
    let thinkingBudget: number | undefined;
    if (typeof req.thinkingBudgetTokens === 'number' && req.thinkingBudgetTokens >= 0) {
      thinkingBudget = Math.min(req.thinkingBudgetTokens, maxBudget);
    } else if (requested) {
      thinkingBudget = gemini25Budget(requested, maxBudget, isPro);
    } else if (req.thinking === true) {
      thinkingBudget = DEFAULT_THINKING_MODE;
    } else if (req.thinking === false && !isPro) {
      thinkingBudget = 0;
    }
    if (thinkingBudget === undefined) return undefined;
    return { includeThoughts: wantsVisibleThoughts, thinkingBudget };
  }

  return req.thinking === true
    ? { includeThoughts: true, thinkingBudget: DEFAULT_THINKING_MODE }
    : undefined;
}

function gemini3SupportedLevels(model: string): ThinkingLevel[] {
  if (model.includes('3.1-pro')) {
    return [ThinkingLevel.LOW, ThinkingLevel.MEDIUM, ThinkingLevel.HIGH];
  }
  return [
    ThinkingLevel.MINIMAL,
    ThinkingLevel.LOW,
    ThinkingLevel.MEDIUM,
    ThinkingLevel.HIGH,
  ];
}

function normalizeGemini3Level(
  value: string | undefined,
  supported: readonly ThinkingLevel[],
): ThinkingLevel | null {
  const mapped =
    value === 'none' || value === 'minimal'
      ? ThinkingLevel.MINIMAL
      : value === 'low'
        ? ThinkingLevel.LOW
        : value === 'medium'
          ? ThinkingLevel.MEDIUM
          : value === 'high' || value === 'xhigh' || value === 'max' || value === 'ultra'
            ? ThinkingLevel.HIGH
            : null;
  if (!mapped) return null;
  return supported.includes(mapped) ? mapped : supported[0] ?? null;
}

function gemini25Budget(value: string, maxBudget: number, isPro: boolean): number {
  if (value === 'none') return isPro ? 128 : 0;
  if (value === 'minimal') return 512;
  if (value === 'low') return 2_048;
  if (value === 'medium') return 8_192;
  return maxBudget;
}

/**
 * Convert the normalized AgentMessage list to Gemini's Content[] shape.
 *
 * Gemini only has `user` and `model` roles. Tool results are sent as a `user`
 * turn containing `functionResponse` parts. Consecutive parts with the same
 * role can be merged, but the SDK is happy with one Content per message, so
 * we keep the 1:1 mapping for readability.
 */
function toGeminiContents(messages: AgentMessage[]): Content[] {
  const out: Content[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      // Each tool_result becomes a functionResponse part in a user turn.
      const parts: Part[] = [];
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        parts.push({
          functionResponse: {
            // The id links back to the functionCall that produced this result.
            // Gemini will match by name if id is absent; we send both.
            id: b.tool_use_id,
            name: b.tool_use_id, // runner doesn't store the name here; fall back.
            response: { result: b.content },
          },
        });
      }
      if (parts.length > 0) out.push({ role: 'user', parts });
      continue;
    }

    if (m.role === 'user') {
      const parts: Part[] = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'image' && b.base64) {
          parts.push({ inlineData: { mimeType: b.mediaType, data: b.base64 } });
        } else if (b.type === 'document' && (b.text || b.path)) {
          parts.push({
            text: renderTextDocument(b),
          });
        } else if (b.type === 'document' && b.base64) {
          parts.push({ inlineData: { mimeType: b.mediaType, data: b.base64 } });
        }
      }
      // tool_result blocks occasionally ride on a user message (runner quirk);
      // route them to the same functionResponse pattern.
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        parts.push({
          functionResponse: {
            id: b.tool_use_id,
            name: b.tool_use_id,
            response: { result: b.content },
          },
        });
      }
      if (parts.length > 0) out.push({ role: 'user', parts });
      continue;
    }

    if (m.role === 'assistant') {
      const parts: Part[] = [];
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') {
          parts.push({
            functionCall: {
              id: b.id,
              name: b.name,
              args: b.input,
            },
          });
        }
      }
      if (parts.length > 0) out.push({ role: 'model', parts });
      continue;
    }
    // system role is ignored here; it goes into config.systemInstruction.
  }

  return out;
}
