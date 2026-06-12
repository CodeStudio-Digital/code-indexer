import type { ChatProvider, ChatRequest } from '@mcp/code-agent/providers/adapter.js';
import type { AgentMessage, ChatDelta, ContentBlock } from '@mcp/code-agent/core/messages.js';

/**
 * Amazon Bedrock chat adapter using the Converse/ConverseStream API.
 *
 * Why Converse instead of per-vendor InvokeModel:
 *   - Bedrock hosts models from Anthropic, Meta, Mistral, Cohere, AI21 and
 *     Amazon. Each has a different native body schema. ConverseStream (added
 *     2024) translates server-side so one adapter works for every model.
 *   - Tool calling is uniform across vendors via toolConfig.tools.
 *   - Prompt caching, cross-region inference and guardrails are all first-
 *     class on Converse.
 *
 * The @aws-sdk is loaded via dynamic import (same trick as the Titan
 * embeddings adapter) so users who don't use Bedrock don't need the ~10MB
 * dep. Instantiation throws a clear install hint when the package is missing.
 *
 * Credential resolution order (tries each, falls back to next):
 *   1. Explicit { accessKeyId, secretAccessKey, sessionToken, region } in opts.
 *   2. AWS SDK's default credential chain (env vars AWS_*, ~/.aws/credentials,
 *      instance/ECS role). Region defaults to AWS_REGION or us-east-1.
 */

// Minimal local types to avoid needing @aws-sdk types at build time.
interface ConverseStreamClient {
  send: (cmd: unknown) => Promise<{ stream: AsyncIterable<ConverseStreamEvent> }>;
}

interface ConverseStreamEvent {
  messageStart?: { role: string };
  contentBlockStart?: {
    contentBlockIndex: number;
    start?: { toolUse?: { toolUseId: string; name: string } };
  };
  contentBlockDelta?: {
    contentBlockIndex: number;
    delta?: { text?: string; toolUse?: { input?: string } };
  };
  contentBlockStop?: { contentBlockIndex: number };
  messageStop?: { stopReason: string };
  metadata?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    };
  };
}

interface BedrockSdkModule {
  BedrockRuntimeClient: new (cfg: unknown) => ConverseStreamClient;
  ConverseStreamCommand: new (input: unknown) => unknown;
}

export class BedrockChatProvider implements ChatProvider {
  readonly name = 'bedrock';
  model: string;
  private region: string;
  private credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
  private clientPromise: Promise<{ client: ConverseStreamClient; sdk: BedrockSdkModule }> | null = null;

  constructor(opts: {
    model?: string;
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
  }) {
    // Default to Claude 3.5 Sonnet v2 — widely available and matches the
    // indexer's pricing tier. Caller can override per-session via /switch.
    this.model = opts.model ?? 'anthropic.claude-3-5-sonnet-20241022-v2:0';
    this.region = opts.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
    if (opts.accessKeyId && opts.secretAccessKey) {
      this.credentials = {
        accessKeyId: opts.accessKeyId,
        secretAccessKey: opts.secretAccessKey,
        sessionToken: opts.sessionToken,
      };
    }
  }

  setModel(model: string): void {
    this.model = model;
  }

  private async getClient(): Promise<{ client: ConverseStreamClient; sdk: BedrockSdkModule }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        let sdk: BedrockSdkModule;
        try {
          const modName = '@aws-sdk/client-bedrock-runtime';
          sdk = (await import(/* @vite-ignore */ modName)) as BedrockSdkModule;
        } catch (e) {
          throw new Error(
            `Bedrock adapter requires @aws-sdk/client-bedrock-runtime. Install with: ` +
              `pnpm add @aws-sdk/client-bedrock-runtime (${(e as Error).message})`
          );
        }
        const client = new sdk.BedrockRuntimeClient({
          region: this.region,
          // Passing `undefined` lets the SDK fall back to its default provider
          // chain (env, shared credentials file, instance role).
          credentials: this.credentials,
        });
        return { client, sdk };
      })();
    }
    return this.clientPromise;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatDelta> {
    const { client, sdk } = await this.getClient();

    const messages = toBedrockMessages(req.messages);
    const system = req.system ? [{ text: req.system }] : undefined;
    const toolConfig = req.tools.length > 0
      ? {
          tools: req.tools.map((t) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              // Bedrock Converse wraps the JSON Schema under inputSchema.json.
              // The schema shape is standard OpenAPI-subset, matching what we
              // already use for every other adapter.
              inputSchema: { json: t.parameters as unknown },
            },
          })),
        }
      : undefined;

    let stream;
    try {
      console.log('\n--- Bedrock Request Debug ---');
      console.log('Model ID sendo enviado:', this.model);
      console.log('Ferramentas carregadas:', toolConfig?.tools?.length ?? 0);
      console.log('Tem System Prompt?', !!system);
      console.log('-----------------------------\n');

      const temperature = req.inference?.temperature;
      const cmd = new sdk.ConverseStreamCommand({
        modelId: this.model,
        messages,
        system,
        toolConfig,
        ...(typeof temperature === 'number'
          ? { inferenceConfig: { temperature } }
          : {}),
      });
      const resp = await client.send(cmd);
      stream = resp.stream;
    } catch (e) {
      throw new Error(humanizeBedrockError(e, this.model));
    }

    // Tool calls arrive as a sequence:
    //   contentBlockStart { start.toolUse: {toolUseId, name} }
    //   contentBlockDelta { delta.toolUse.input: "<partial json>" } ... (repeat)
    //   contentBlockStop
    // We accumulate per contentBlockIndex and emit tool_call_end on stop.
    const toolAcc = new Map<number, { id: string; name: string; argsAcc: string }>();
    let finishReason: string | undefined;
    let usage: ChatDelta | null = null;

    try {
      for await (const event of stream) {
        if (event.contentBlockStart?.start?.toolUse) {
          const idx = event.contentBlockStart.contentBlockIndex;
          const tu = event.contentBlockStart.start.toolUse;
          toolAcc.set(idx, { id: tu.toolUseId, name: tu.name, argsAcc: '' });
          yield { type: 'tool_call_start', id: tu.toolUseId, name: tu.name };
          continue;
        }
        if (event.contentBlockDelta) {
          const idx = event.contentBlockDelta.contentBlockIndex;
          const delta = event.contentBlockDelta.delta;
          if (delta?.text) {
            yield { type: 'text_delta', text: delta.text };
          }
          if (delta?.toolUse?.input) {
            const acc = toolAcc.get(idx);
            if (acc) {
              acc.argsAcc += delta.toolUse.input;
              yield { type: 'tool_call_args', id: acc.id, partial_json: delta.toolUse.input };
            }
          }
          continue;
        }
        if (event.contentBlockStop) {
          const idx = event.contentBlockStop.contentBlockIndex;
          const acc = toolAcc.get(idx);
          if (acc) {
            let input: Record<string, unknown> = {};
            try {
              input = acc.argsAcc ? (JSON.parse(acc.argsAcc) as Record<string, unknown>) : {};
            } catch {
              input = { _raw: acc.argsAcc };
            }
            yield { type: 'tool_call_end', id: acc.id, name: acc.name, input };
            toolAcc.delete(idx);
          }
          continue;
        }
        if (event.messageStop) {
          finishReason = event.messageStop.stopReason;
          continue;
        }
        if (event.metadata?.usage) {
          const u = event.metadata.usage;
          usage = {
            type: 'usage',
            usage: {
              input_tokens: u.inputTokens ?? 0,
              output_tokens: u.outputTokens ?? 0,
              cache_read_input_tokens: u.cacheReadInputTokens ?? 0,
              cache_creation_input_tokens: u.cacheWriteInputTokens ?? 0,
              // Bedrock (Anthropic-style) splits the prompt: inputTokens excludes cache.
              prompt_tokens_total:
                (u.inputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheWriteInputTokens ?? 0),
            },
          };
        }
      }
    } catch (e) {
      throw new Error(humanizeBedrockError(e, this.model));
    }

    if (usage) yield usage;
    yield { type: 'done', stop_reason: finishReason };
  }
}

// ─── Message mapping ────────────────────────────────────────────

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

type BedrockContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | { toolResult: { toolUseId: string; content: Array<{ text: string }>; status?: 'success' | 'error' } }
  | { image: { format: string; source: { bytes: Uint8Array } } }
  | { document: { name: string; format: string; source: { bytes: Uint8Array } } };

/**
 * Translate the runner's normalized AgentMessage list to Bedrock Converse's
 * messages array. Bedrock only has user/assistant roles — tool results go
 * into a `user` turn via toolResult blocks, mirroring the Anthropic schema.
 *
 * The runner's tool_result blocks lose the name of the tool they came from,
 * but Bedrock only needs toolUseId to thread the result back to the matching
 * toolUse block, so that's fine.
 */
function toBedrockMessages(messages: AgentMessage[]): BedrockMessage[] {
  const out: BedrockMessage[] = [];

  for (const m of messages) {
    if (m.role === 'tool') {
      const content: BedrockContentBlock[] = [];
      for (const b of m.content) {
        if (b.type !== 'tool_result') continue;
        content.push({
          toolResult: {
            toolUseId: b.tool_use_id,
            content: [{ text: b.content }],
            status: b.is_error ? 'error' : 'success',
          },
        });
      }
      if (content.length > 0) out.push({ role: 'user', content });
      continue;
    }

    if (m.role === 'user') {
      const content: BedrockContentBlock[] = [];
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'text' && b.text) content.push({ text: b.text });
        else if (b.type === 'image' && b.base64) {
          content.push({
            image: {
              format: b.mediaType.replace('image/', ''),
              source: { bytes: base64ToBytes(b.base64) },
            },
          });
        } else if (b.type === 'document' && b.text) {
          content.push({
            text: `<document name="${b.name}" mediaType="${b.mediaType}">\n${b.text}\n</document>`,
          });
        } else if (b.type === 'tool_result') {
          // Runner quirk — occasionally tool_results ride on a user message.
          content.push({
            toolResult: {
              toolUseId: b.tool_use_id,
              content: [{ text: b.content }],
              status: b.is_error ? 'error' : 'success',
            },
          });
        }
      }
      if (content.length > 0) out.push({ role: 'user', content });
      continue;
    }

    if (m.role === 'assistant') {
      const content: BedrockContentBlock[] = [];
      for (const b of m.content as ContentBlock[]) {
        if (b.type === 'text' && b.text) content.push({ text: b.text });
        else if (b.type === 'tool_use') {
          content.push({
            toolUse: { toolUseId: b.id, name: b.name, input: b.input },
          });
        }
      }
      if (content.length > 0) out.push({ role: 'assistant', content });
    }
    // system role is ignored — it goes into `system` config, not messages.
  }

  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

// ─── Error humanizer ───────────────────────────────────────────

function humanizeBedrockError(e: unknown, model: string): string {
  // Dump raw trace to terminal for deep-debugging (e.g. AWS requestId, HTTP status)
  console.error('\n[Bedrock Raw Trace]:', e, '\n');

  if (!(e instanceof Error)) return String(e);
  const msg = e.message;
  const name = e.name;

  // SDK errors carry the AWS error name in .name (e.g. 'AccessDeniedException',
  // 'ValidationException', 'ThrottlingException', 'ModelNotReadyException').
  if (name === 'AccessDeniedException' || /access denied|not authorized/i.test(msg)) {
    return (
      `Bedrock access denied for model "${model}". ` +
      `Check that your AWS credentials have bedrock:InvokeModelWithResponseStream ` +
      `permission and that you've enabled model access at ` +
      `https://console.aws.amazon.com/bedrock/home#/modelaccess. Details: ${msg}`
    );
  }
  if (name === 'ValidationException' && /model identifier/i.test(msg)) {
    return (
      `Bedrock rejected model id "${model}" — not available in your region or not yet enabled. ` +
      `Enable it at https://console.aws.amazon.com/bedrock/home#/modelaccess. Details: ${msg}`
    );
  }
  if (name === 'ThrottlingException') {
    return `Bedrock throttled the request for "${model}". Retry after a short backoff. Details: ${msg}`;
  }
  if (name === 'ResourceNotFoundException') {
    return `Bedrock model "${model}" not found in the current region. Details: ${msg}`;
  }
  return `Bedrock error (${name || 'unknown'}): ${msg}`;
}
