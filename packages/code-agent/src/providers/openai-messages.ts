import OpenAI from 'openai';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import {
  renderTextDocument,
  safeDocumentFilename,
  unsupportedBinaryDocumentText,
} from './document-utils.js';
/**
 * OpenAI-compatible chat adapter (works with OpenAI, OpenRouter, ZAI/GLM, DeepSeek and any
 * provider that implements the OpenAI chat completions schema with function
 * calling and streaming).
 */
export type OpenAICompatVendor =
  | 'openai'
  | 'openrouter'
  | 'zai'
  | 'deepseek'
  | 'copilot'
  | 'fugu'
  | 'mistral';


export type OAIMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;


export function toOpenAIMessages(system: string, messages: AgentMessage[], vendor?: OpenAICompatVendor): OAIMsg[] {
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
        | { type: 'file'; file: { filename: string; file_data: string } }
      > = [];
      for (const b of m.content) {
        if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
        else if (b.type === 'image') {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
          });
        } else if (
          b.type === 'document'
          && b.base64
          && (vendor === 'openai' || vendor === 'openrouter')
        ) {
          parts.push({
            type: 'file',
            file: {
              filename: safeDocumentFilename(b),
              file_data: `data:${b.mediaType};base64,${b.base64}`,
            },
          });
        } else if (b.type === 'document' && (b.text || b.path)) {
          parts.push({
            type: 'text',
            text: renderTextDocument(b),
          });
        } else if (b.type === 'document' && b.base64) {
          parts.push({ type: 'text', text: unsupportedBinaryDocumentText(b) });
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
      const reasoning = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
        .map((b) => b.text)
        .join('');
      const text = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('');
      const toolUses = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
      // DeepSeek V4 requires reasoning_content to be passed back in multi-turn
      // conversations that include tool calls — without it the API rejects the
      // request. Other vendors ignore unknown fields, so it's safe to include
      // for deepseek only to avoid polluting other providers' payloads.
      const mistralContent =
        vendor === 'mistral' && reasoning
          ? [
              { type: 'thinking', thinking: [{ type: 'text', text: reasoning }] },
              ...(text ? [{ type: 'text', text }] : []),
            ]
          : null;
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: mistralContent ?? (text || ""),
        ...(vendor === 'deepseek' ? { reasoning_content: reasoning } : {}),
      };
      if (toolUses.length > 0) {
        msg['tool_calls'] = toolUses.map((tu) => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          },
        }));
      }
      out.push(msg as unknown as OAIMsg);
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
