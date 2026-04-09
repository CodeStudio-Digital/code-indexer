import Anthropic from '@anthropic-ai/sdk';
import type { ChatProvider, ChatRequest } from './adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '../core/messages.js';

/**
 * Anthropic chat adapter with tool use and streaming.
 *
 * Translates the normalized AgentMessage format to Anthropic's
 * messages.create() schema and re-emits stream events as ChatDelta.
 */
export class AnthropicChatProvider implements ChatProvider {
  readonly name = 'anthropic';
  model: string;
  private client: Anthropic;

  constructor(opts: { apiKey?: string; baseURL?: string; model?: string }) {
    this.model = opts.model ?? 'claude-sonnet-4-6';
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const messages = req.messages.map(toAnthropicMessage).filter((m): m is Anthropic.MessageParam => m !== null);
    const tools: Anthropic.Tool[] = req.tools.map((t, i, arr) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as unknown as Anthropic.Tool.InputSchema,
      // Cache breakpoint on the LAST tool covers the entire tools[] array.
      ...(i === arr.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
    }));

    // Cache the system prompt as well — identical across every turn.
    const systemBlocks: Anthropic.TextBlockParam[] = req.system
      ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' as const } }]
      : [];

    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: 8192,
      system: systemBlocks.length > 0 ? systemBlocks : undefined,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    // Track in-progress tool uses indexed by content block index
    const toolBlocks = new Map<number, { id: string; name: string; jsonAcc: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case 'content_block_start': {
          const block = event.content_block;
          if (block.type === 'tool_use') {
            toolBlocks.set(event.index, { id: block.id, name: block.name, jsonAcc: '' });
            yield { type: 'tool_call_start', id: block.id, name: block.name };
          }
          break;
        }
        case 'content_block_delta': {
          const d = event.delta;
          if (d.type === 'text_delta') {
            yield { type: 'text_delta', text: d.text };
          } else if (d.type === 'input_json_delta') {
            const tb = toolBlocks.get(event.index);
            if (tb) {
              tb.jsonAcc += d.partial_json;
              yield { type: 'tool_call_args', id: tb.id, partial_json: d.partial_json };
            }
          }
          break;
        }
        case 'content_block_stop': {
          const tb = toolBlocks.get(event.index);
          if (tb) {
            let input: Record<string, unknown> = {};
            try {
              input = tb.jsonAcc ? JSON.parse(tb.jsonAcc) : {};
            } catch {
              input = { _raw: tb.jsonAcc };
            }
            yield { type: 'tool_call_end', id: tb.id, name: tb.name, input };
            toolBlocks.delete(event.index);
          }
          break;
        }
        case 'message_delta': {
          // MessageDeltaUsage only carries cumulative output_tokens. The full
          // usage (with input_tokens) arrives via finalMessage() below.
          break;
        }
        case 'message_stop':
          yield { type: 'done' };
          break;
        default:
          break;
      }
    }

    // Final usage from the completed message (more reliable than message_delta)
    const final = await stream.finalMessage();
    if (final.usage) {
      yield {
        type: 'usage',
        usage: {
          input_tokens: final.usage.input_tokens ?? 0,
          output_tokens: final.usage.output_tokens ?? 0,
          cache_creation_input_tokens: final.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: final.usage.cache_read_input_tokens ?? 0,
        },
      };
    }
  }
}

function toAnthropicMessage(m: AgentMessage): Anthropic.MessageParam | null {
  // Anthropic has only 'user' and 'assistant' roles. Tool results are sent as
  // a user message containing tool_result blocks.
  if (m.role === 'system') return null;

  if (m.role === 'tool') {
    return {
      role: 'user',
      content: m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result')
        .map((b) => ({
          type: 'tool_result' as const,
          tool_use_id: b.tool_use_id,
          content: b.content,
          is_error: b.is_error ?? false,
        })),
    };
  }

  if (m.role === 'user') {
    const userContent: Anthropic.ContentBlockParam[] = m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
        if (b.type === 'text') return [{ type: 'text' as const, text: b.text }];
        if (b.type === 'tool_result') {
          return [{
            type: 'tool_result' as const,
            tool_use_id: b.tool_use_id,
            content: b.content,
            is_error: b.is_error ?? false,
          }];
        }
        if (b.type === 'image') {
          return [{
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: (b.mediaType || 'image/png') as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
              data: b.base64,
            },
          }];
        }
        if (b.type === 'document') {
          if (b.base64 && b.mediaType === 'application/pdf') {
            return [{
              type: 'document' as const,
              source: {
                type: 'base64' as const,
                media_type: 'application/pdf' as const,
                data: b.base64,
              },
            }];
          }
          if (b.text) {
            return [{ type: 'text' as const, text: `<document name="${b.name}" mediaType="${b.mediaType}">\n${b.text}\n</document>` }];
          }
          return [];
        }
        return [];
      });
    return { role: 'user', content: userContent };
  }

  // assistant
  const assistantContent: Anthropic.ContentBlockParam[] = m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
    if (b.type === 'text') return [{ type: 'text', text: b.text }];
    if (b.type === 'tool_use') {
      return [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }];
    }
    return [];
  });
  return { role: 'assistant', content: assistantContent };
}
