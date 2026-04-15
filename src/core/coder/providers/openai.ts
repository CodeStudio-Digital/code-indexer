import OpenAI from 'openai';
import type { ChatProvider, ChatRequest } from './adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '../core/messages.js';

/**
 * OpenAI-compatible chat adapter (works with OpenAI, ZAI/GLM, DeepSeek and any
 * provider that implements the OpenAI chat completions schema with function
 * calling and streaming).
 */
export class OpenAIChatProvider implements ChatProvider {
  readonly name: string;
  model: string;
  private client: OpenAI;

  constructor(opts: {
    name?: string;
    apiKey?: string;
    baseURL?: string;
    model: string;
    defaultHeaders?: Record<string, string>;
  }) {
    this.name = opts.name ?? 'openai';
    this.model = opts.model;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      ...(opts.defaultHeaders ? { defaultHeaders: opts.defaultHeaders } : {}),
    });

    console.log(opts.baseURL)
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const messages = toOpenAIMessages(req.system, req.messages);
    const tools = req.tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters as unknown as Record<string, unknown>,
      },
    }));

    try {
      // DEBUG LOGGING
      /*const fs = await import('node:fs');
      const path = await import('node:path');
      fs.writeFileSync(
        path.join(process.cwd(), 'zai-debug-request.json'),
        JSON.stringify({ model: this.model, messages, tools: tools.length > 0 ? tools : undefined }, null, 2)
      );*/
    } catch {}

    let stream;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        stream: true,
        stream_options: { include_usage: true },
      });
    } catch (apiErr: any) {
      try {
        /*const fs = await import('node:fs');
        const path = await import('node:path');
        fs.writeFileSync(
          path.join(process.cwd(), 'zai-debug-error.json'),
          JSON.stringify({ error: apiErr, response: apiErr.response?.data || apiErr.error }, null, 2)
        );*/
      } catch {}
      throw apiErr;
    }

    // Tool calls arrive in deltas indexed by `tool_calls[i].index`.
    const toolAcc = new Map<number, { id: string; name: string; argsAcc: string; emittedStart: boolean }>();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) {
        yield { type: 'text_delta', text: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          let acc = toolAcc.get(idx);
          if (!acc) {
            acc = { id: tc.id ?? `tool_${idx}`, name: tc.function?.name ?? '', argsAcc: '', emittedStart: false };
            toolAcc.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.argsAcc += tc.function.arguments;
          if (!acc.emittedStart && acc.name) {
            acc.emittedStart = true;
            yield { type: 'tool_call_start', id: acc.id, name: acc.name };
          }
          if (tc.function?.arguments) {
            yield { type: 'tool_call_args', id: acc.id, partial_json: tc.function.arguments };
          }
        }
      }
      if (chunk.usage) {
        // OpenAI / ZAI / GLM return cached prompt tokens in prompt_tokens_details.
        // DeepSeek uses a different shape (prompt_cache_hit_tokens) — read both.
        const u = chunk.usage as unknown as {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
          prompt_cache_hit_tokens?: number;
        };
        const cachedRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
        yield {
          type: 'usage',
          usage: {
            input_tokens: u.prompt_tokens ?? 0,
            output_tokens: u.completion_tokens ?? 0,
            cache_read_input_tokens: cachedRead,
          },
        };
      }
      if (choice?.finish_reason) {
        // Flush all tool calls now that the message is complete
        for (const acc of toolAcc.values()) {
          let input: Record<string, unknown> = {};
          try {
            input = acc.argsAcc ? JSON.parse(acc.argsAcc) : {};
          } catch {
            input = { _raw: acc.argsAcc };
          }
          yield { type: 'tool_call_end', id: acc.id, name: acc.name, input };
        }
        toolAcc.clear();
        yield { type: 'done', stop_reason: choice.finish_reason };
      }
    }
  }
}

type OAIMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAIMessages(system: string, messages: AgentMessage[]): OAIMsg[] {
  const out: OAIMsg[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'tool') {
      // Each tool_result becomes a separate `role: 'tool'` message
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        out.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.content,
        });
      }
      continue;
    }

    if (m.role === 'user') {
      // Build a multimodal content array (text + image_url) when applicable.
      const parts: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
          });
        } else if (b.type === 'document' && b.text) {
          parts.push({
            type: 'text',
            text: `<document name="${b.name}" mediaType="${b.mediaType}">\n${b.text}\n</document>`,
          });
        }
      }
      const toolResults = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      if (parts.length > 0) {
        const onlyText = parts.every((p) => p.type === 'text');
        if (onlyText) {
          out.push({ role: 'user', content: parts.map((p) => (p as { text: string }).text).join('\n') });
        } else {
          out.push({ role: 'user', content: parts as unknown as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'] });
        }
      }
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
      }
      continue;
    }

    if (m.role === 'assistant') {
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      const msg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: text || "",
      };
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }));
      }
      out.push(msg);
    }
  }

  // Guard: strict OpenAI-compatible providers (GLM/ZAI) may reject messages
  // that don't start with a user turn after the system message. This can
  // happen when the summarizer replaces the opening user message with a
  // synthetic assistant summary.
  if (out.length > 1 && out[1].role !== 'user') {
    out.splice(1, 0, { role: 'user', content: '[Conversation continues from summarized context.]' });
  }

  return out;
}
