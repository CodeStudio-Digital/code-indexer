/**
 * Teacher client — thin wrapper over the existing provider resolver
 * (`createCoderProvider`). Runs one non-tool completion against an
 * already-configured provider, accumulates text + token usage, parses the
 * strict JSON example, and prices the call via the central pricing table.
 */
import { createCoderProvider } from '../../providers/factory.js';
import { calculateCost } from '../../providers/pricing.js';
import type { ChatProvider } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage } from '@mcp/code-agent/core/messages.js';
import type { GeneratedExample } from './types.js';

export class TeacherClient {
  private constructor(private provider: ChatProvider) {}

  static async create(providerName?: string, model?: string): Promise<TeacherClient> {
    const provider = await createCoderProvider(providerName, model);
    return new TeacherClient(provider);
  }

  async generateExample(
    system: string,
    messages: AgentMessage[],
    signal?: AbortSignal,
  ): Promise<GeneratedExample> {
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for await (const delta of this.provider.chat({ system, messages, tools: [], signal })) {
      if (delta.type === 'text_delta') text += delta.text;
      else if (delta.type === 'usage') {
        inputTokens = delta.usage.input_tokens;
        outputTokens = delta.usage.output_tokens;
      }
    }

    const parsed = parseExampleJson(text);
    return {
      instruction: parsed.instruction,
      input: parsed.input ?? '',
      output: parsed.output,
      inputTokens,
      outputTokens,
      costUsd: calculateCost(this.provider.model, inputTokens, outputTokens),
    };
  }
}

interface RawExample {
  instruction: string;
  input?: string;
  output: string;
}

/** Tolerant JSON extraction — strips code fences and slices to the outer braces. */
export function parseExampleJson(raw: string): RawExample {
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Teacher returned no JSON object: ${raw.slice(0, 200)}`);
  }
  const obj = JSON.parse(s.slice(start, end + 1)) as RawExample;
  if (typeof obj.instruction !== 'string' || typeof obj.output !== 'string') {
    throw new Error('Teacher JSON missing required instruction/output fields');
  }
  return obj;
}
