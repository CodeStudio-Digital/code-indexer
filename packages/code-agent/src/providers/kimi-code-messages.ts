import OpenAI from 'openai';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { renderTextDocument } from './document-utils.js';
import type { JsonSchema } from '@mcp/code-agent/core/tool.js';
export type KimiMsg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export type KimiReasoningKey = 'reasoning_content' | 'reasoning_details' | 'reasoning';


/**
 * Convert a runtime Tool into the param shape the Kimi API expects.
 *
 * Kimi-for-Coding exposes server-side **builtin functions** whose names
 * start with `$` (e.g. `$web_search`, `$crawl`). These must be declared
 * with `type: 'builtin_function'` and carry only the name — the server
 * already knows the description and schema. Sending them as a regular
 * `type: 'function'` works (Kimi tolerates it) but the server invokes
 * a local round-trip instead of running the native builtin, wasting a
 * turn and money. Mirrors kosong's `_convert_tool`
 * (`.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:344-356`).
 *
 * Exported for unit tests.
 */
export function toKimiToolParam(tool: {
  name: string;
  description?: string;
  parameters?: JsonSchema | unknown;
}): Record<string, unknown> {
  if (tool.name.startsWith('$')) {
    return {
      type: 'builtin_function',
      function: { name: tool.name },
    };
  }
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeKimiToolParameters(tool.parameters),
    },
  };
}


export function normalizeKimiToolParameters(schema: JsonSchema | unknown): Record<string, unknown> {
  const normalized = normalizeSchema(schema, true);
  if (normalized && typeof normalized === 'object' && !Array.isArray(normalized)) {
    const obj = normalized as Record<string, unknown>;
    // The Kimi tool wrapper has a stricter root contract than an arbitrary
    // MFJS node: function.parameters itself must always be an object. A root
    // $ref cannot coexist with that required type, so prefer an explicit,
    // permissive object; nested refs remain intact.
    if (typeof obj.$ref === 'string') delete obj.$ref;
    obj.type = 'object';
    return obj;
  }
  return { type: 'object', properties: {} };
}


export function normalizeSchema(value: unknown, isToolParametersRoot = false): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeSchema(item));
  if (!value || typeof value !== 'object') return value;

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
      out[key] = Object.fromEntries(
        Object.entries(child as Record<string, unknown>).map(([propertyName, propertySchema]) => [
          propertyName,
          normalizeKimiPropertySchema(propertySchema),
        ]),
      );
      continue;
    }
    out[key] = normalizeSchema(child);
  }

  if (hasAnyOf(out)) {
    if (isToolParametersRoot) {
      // `function.parameters` must have root type=object, while MFJS also
      // rejects type beside anyOf. There is no legal root representation for
      // that standard JSON Schema combination. Collapse only the root union,
      // merge any branch-only properties so the model still sees them, and
      // leave the original conditional validation to the MCP server.
      mergeRootAnyOfProperties(out);
      delete out.anyOf;
      out.type = 'object';
    } else {
      // For nested schemas MFJS's normal rule applies: move the parent type
      // into untyped branches and remove it from the union node.
      const parentType = out.type;
      if (parentType !== undefined) {
        out.anyOf = (out.anyOf as unknown[]).map((branch) => {
          if (!branch || typeof branch !== 'object' || Array.isArray(branch)) return branch;
          const branchSchema = branch as Record<string, unknown>;
          if (
            branchSchema.type !== undefined ||
            hasAnyOf(branchSchema) ||
            typeof branchSchema.$ref === 'string'
          ) {
            return branchSchema;
          }
          return { ...branchSchema, type: parentType };
        });
      }
      delete out.type;
    }
  } else if (!isToolParametersRoot && typeof out.$ref === 'string') {
    // The same MFJS parent-type rule applies to referenced schemas.
    delete out.type;
  } else if (!out.type) {
    if (out.properties && typeof out.properties === 'object') {
      out.type = 'object';
    } else if (out.items) {
      out.type = 'array';
    } else if (Array.isArray(out.enum) && out.enum.length > 0) {
      out.type = inferScalarType(out.enum[0]);
    } else if (out.const !== undefined) {
      out.type = inferScalarType(out.const);
    }
  }

  return out;
}


export function hasAnyOf(schema: Record<string, unknown>): boolean {
  return Array.isArray(schema.anyOf) && schema.anyOf.length > 0;
}


export function mergeRootAnyOfProperties(schema: Record<string, unknown>): void {
  const currentProperties =
    schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? schema.properties as Record<string, unknown>
      : {};
  const mergedProperties = { ...currentProperties };

  for (const branch of schema.anyOf as unknown[]) {
    if (!branch || typeof branch !== 'object' || Array.isArray(branch)) continue;
    const branchProperties = (branch as Record<string, unknown>).properties;
    if (!branchProperties || typeof branchProperties !== 'object' || Array.isArray(branchProperties)) {
      continue;
    }
    for (const [name, propertySchema] of Object.entries(branchProperties)) {
      if (!(name in mergedProperties)) mergedProperties[name] = propertySchema;
    }
  }

  if (Object.keys(mergedProperties).length > 0) schema.properties = mergedProperties;
}


export function normalizeKimiPropertySchema(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return normalizeSchema(value) as Record<string, unknown>;
  }

  // Some dynamically discovered/MCP tools use the common shorthand
  // `properties: { name: "string" }`. It is understandable to permissive
  // consumers, but Kimi validates its Moonshot-flavored schema strictly and
  // requires every property value to be a schema object.
  if (typeof value === 'string' && JSON_SCHEMA_TYPES.has(value)) {
    return { type: value };
  }

  // Boolean schemas and other invalid shorthand are valid in newer JSON
  // Schema dialects but are not accepted by the Kimi tool endpoint. An empty
  // schema preserves their permissive meaning without sending an invalid
  // property shape.
  return {};
}


export const JSON_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'integer',
  'null',
  'number',
  'object',
  'string',
]);


export function inferScalarType(value: unknown): string {
  switch (typeof value) {
    case 'number':
      return Number.isInteger(value) ? 'integer' : 'number';
    case 'boolean':
      return 'boolean';
    case 'object':
      return Array.isArray(value) ? 'array' : 'object';
    default:
      return 'string';
  }
}


/**
 * True when `text` is empty or made only of whitespace characters. Mirrors
 * kosong's `_is_effectively_empty_content_parts` helper
 * (`.reference/kimi-cli/packages/kosong/src/kosong/chat_provider/kimi.py:335-341`).
 *
 * The Kimi-for-Coding API rejects assistant messages whose `content` is
 * `""` or whitespace-only when `tool_calls` is also present
 * (HTTP 400 "text content is empty"). Dropping the field entirely is
 * always accepted, so callers use this predicate to decide.
 *
 * Exported for unit tests.
 */
export function isEffectivelyEmptyText(text: string): boolean {
  return text.trim().length === 0;
}


/**
 * Diagnostic helper: summarize assistant-message `content` shape for debug
 * logging. Confirms H2 (Kimi rejects `content: ""` / whitespace-only when
 * tool_calls is present — observed in `kosong/kimi.py:318-329`).
 *
 * Returns one descriptor per assistant message, in order. Values:
 *   - 'omitted'   — content field absent (correct for tool_calls + empty).
 *   - 'empty'     — string '' (suspect with tool_calls).
 *   - 'whitespace' — string of only \s (suspect with tool_calls).
 *   - 'text'      — non-empty string.
 *   - 'array:N'   — content is an array of N parts.
 *   - 'other'     — anything else.
 */
export function summarizeAssistantContentTypes(messages: KimiMsg[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const c = (m as { content?: unknown }).content;
    if (c === undefined) out.push('omitted');
    else if (typeof c === 'string') {
      if (c === '') out.push('empty');
      else if (c.trim() === '') out.push('whitespace');
      else out.push('text');
    } else if (Array.isArray(c)) out.push(`array:${c.length}`);
    else out.push('other');
  }
  return out;
}


export function toKimiMessages(
  system: string,
  messages: AgentMessage[],
  preservedThinkingEnabled = false,
  reasoningKey: KimiReasoningKey = 'reasoning_content',
): KimiMsg[] {
  const out: KimiMsg[] = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'tool') {
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
      appendUserMessage(out, m.content);
      continue;
    }

    if (m.role === 'assistant') {
      appendAssistantMessage(out, m.content, preservedThinkingEnabled, reasoningKey);
    }
  }

  if (out.length > 1 && out[1].role !== 'user') {
    out.splice(1, 0, { role: 'user', content: '[Conversation continues from summarized context.]' });
  }

  return out;
}


export function appendUserMessage(out: KimiMsg[], blocks: ContentBlock[]): void {
  const parts: Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  > = [];
  const toolResults: Extract<ContentBlock, { type: 'tool_result' }>[] = [];

  for (const b of blocks) {
    if (b.type === 'text' && b.text) parts.push({ type: 'text', text: b.text });
    else if (b.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
      });
    } else if (b.type === 'document' && (b.text || b.path)) {
      parts.push({
        type: 'text',
        text: renderTextDocument(b),
      });
    } else if (b.type === 'tool_result') {
      toolResults.push(b);
    }
  }

  if (parts.length > 0) {
    const onlyText = parts.every((p) => p.type === 'text');
    if (onlyText) {
      out.push({
        role: 'user',
        content: parts.map((p) => (p as { text: string }).text).join('\n'),
      });
    } else {
      out.push({
        role: 'user',
        content: parts as unknown as OpenAI.Chat.Completions.ChatCompletionUserMessageParam['content'],
      });
    }
  }

  for (const tr of toolResults) {
    out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content });
  }
}


export function appendAssistantMessage(
  out: KimiMsg[],
  blocks: ContentBlock[],
  preservedThinkingEnabled: boolean,
  reasoningKey: KimiReasoningKey,
): void {
  const reasoning = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'thinking' }> => b.type === 'thinking')
    .map((b) => b.text)
    .join('');
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('');
  const toolUses = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );

  const msg: Record<string, unknown> = { role: 'assistant' };
  // H2 fix: Kimi-for-Coding rejects assistant messages whose `content` is
  // empty or whitespace-only when `tool_calls` is also present (400 "text
  // content is empty"). Omit `content` entirely in that case — accepted
  // by all OpenAI-compatible APIs. Retains old behavior when there are no
  // tool_uses, so non-Kimi-specific code paths see `content: ''` like before.
  const dropContent = toolUses.length > 0 && isEffectivelyEmptyText(text);
  if (!dropContent) msg.content = text;
  // In preserved-thinking mode Kimi requires this field even when a tool-call
  // assistant message happened to contain an empty reasoning fragment.
  if (reasoning || preservedThinkingEnabled) msg[reasoningKey] = reasoning;
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
  out.push(msg as unknown as KimiMsg);
}
