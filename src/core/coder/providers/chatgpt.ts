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
import { randomUUID } from 'node:crypto';
import type { ChatProvider, ChatRequest } from './adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '../core/messages.js';

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

  constructor(opts: {
    name?: string;
    apiKey: string;
    baseURL: string;
    model: string;
    accountId?: string | null;
  }) {
    this.name = opts.name ?? 'chatgpt';
    this.model = opts.model;
    this.sessionId = randomUUID();

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
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const input = toResponsesInput(req.messages);
    const tools = req.tools.map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters as unknown as Record<string, unknown>,
      strict: false,
    }));

    // The SDK's responses.create is typed loosely; cast through unknown to
    // avoid version-skew compile errors on the experimental shape. Runtime
    // behavior is what matters — Codex accepts the stable shape below.
    const stream = (await (this.client as unknown as {
      responses: {
        create: (args: Record<string, unknown>) => Promise<AsyncIterable<Record<string, unknown>>>;
      };
    }).responses.create({
      model: this.model,
      instructions: req.system,
      input,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
      stream: true,
      store: false,
    })) as AsyncIterable<Record<string, unknown>>;

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

      // A new output item appeared. Two cases we care about:
      //   - function_call → capture id+name, emit tool_call_start
      //   - message (assistant text) → nothing to do (deltas cover it)
      if (type === 'response.output_item.added') {
        const item = evt.item as
          | { type: string; id?: string; call_id?: string; name?: string }
          | undefined;
        if (item?.type === 'function_call' && item.id) {
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

      // Partial JSON arguments for a function_call.
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

      // Final args payload (also contains .arguments string). We already
      // streamed the deltas above; use this as the cue to emit tool_call_end.
      if (type === 'response.function_call_arguments.done') {
        const itemId = evt.item_id as string | undefined;
        if (!itemId) continue;
        const acc = toolAcc.get(itemId);
        if (!acc) continue;
        let parsed: Record<string, unknown> = {};
        try {
          parsed = acc.argsAcc ? (JSON.parse(acc.argsAcc) as Record<string, unknown>) : {};
        } catch {
          parsed = { _raw: acc.argsAcc };
        }
        yield { type: 'tool_call_end', id: acc.call_id, name: acc.name, input: parsed };
        toolAcc.delete(itemId);
        continue;
      }

      // Terminal event — emit usage + done.
      if (type === 'response.completed') {
        const response = evt.response as
          | {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
              };
              status?: string;
            }
          | undefined;
        const u = response?.usage;
        if (u) {
          yield {
            type: 'usage',
            usage: {
              input_tokens: u.input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
              cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
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
      >;
    }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

function toResponsesInput(messages: AgentMessage[]): ResponsesInputItem[] {
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
      > = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) {
          parts.push({ type: 'input_text', text: b.text });
        } else if (b.type === 'image') {
          parts.push({
            type: 'input_image',
            image_url: `data:${b.mediaType};base64,${b.base64}`,
          });
        } else if (b.type === 'document' && b.text) {
          parts.push({
            type: 'input_text',
            text: `<document name="${b.name}" mediaType="${b.mediaType}">\n${b.text}\n</document>`,
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
