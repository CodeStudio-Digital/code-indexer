import {
  agentV1Artifact,
  agentV1Runtime,
} from '@mcp/agent-runtime-contracts';
import type { ChatRequest, ToolSpec } from '@mcp/provider-sdk/adapter.js';
import type { AgentMessage, ContentBlock } from '@mcp/provider-sdk/wire.js';
import { applyPreparedUserContext } from '../native/PreparedUserContext.js';
import { applyPreparedBoundaryContext } from '../native/PreparedBoundaryContext.js';
import { ProviderGatewayError } from './ProviderGatewayError.js';
import { RequestByteBudget } from './ProviderRequestBudget.js';
import type {
  ProviderArtifactReaderPort,
  ProviderGatewayLimits,
} from './ProviderGatewayTypes.js';
import {
  asJsonSchema,
  boundedText,
  parseJsonObject,
  safeNumber,
  verifyArtifact,
} from './ProviderGatewayValidation.js';
import {
  isTextMediaType,
  phaseFromWire,
  roleFromWire,
} from './ProviderMessageMapping.js';

export async function adaptProviderRequest(
  start: agentV1Runtime.ProviderStart,
  reader: ProviderArtifactReaderPort | undefined,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
): Promise<ChatRequest> {
  if (start.messages.length > limits.maxMessages || start.tools.length > limits.maxTools) {
    throw new ProviderGatewayError(
      'provider_request_too_large',
      'provider request exceeds its structural bounds',
    );
  }
  const contentBlocks = start.messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  if (!Number.isSafeInteger(contentBlocks) || contentBlocks > limits.maxContentBlocks) {
    throw new ProviderGatewayError(
      'provider_request_too_large',
      'provider content blocks exceed their structural bound',
    );
  }
  const budget = new RequestByteBudget(limits.maxRequestBytes);
  const system = start.system
    ? await readText(start.system, reader, limits, signal, budget)
    : '';
  const messages: AgentMessage[] = [];
  for (const message of start.messages) {
    messages.push(await adaptMessage(message, reader, limits, signal, budget));
  }
  applyPreparedUserContext(start, messages, contentBlocks, limits.maxContentBlocks, bytes => budget.add(bytes));
  applyPreparedBoundaryContext(start, messages, contentBlocks, limits.maxContentBlocks, bytes => budget.add(bytes));
  const tools = start.tools.map((tool) => adaptTool(tool, limits, budget));
  return {
    system,
    messages,
    tools,
    thinking: start.thinking,
    reasoningEffort: start.reasoningEffort,
    thinkingBudgetTokens: optionalSafeNumber(start.thinkingBudgetTokens, 'thinkingBudgetTokens'),
    previousResponseId: start.previousResponseId,
    previousResponseMessageCount: optionalSafeNumber(
      start.previousResponseMessageCount,
      'previousResponseMessageCount',
    ),
    sessionId: start.identity?.sessionId,
    signal,
  };
}

async function adaptMessage(
  message: agentV1Runtime.ProviderMessage,
  reader: ProviderArtifactReaderPort | undefined,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
  budget: RequestByteBudget,
): Promise<AgentMessage> {
  const role = roleFromWire(message.role);
  const content: ContentBlock[] = [];
  for (const block of message.content) {
    switch (block.body.case) {
      case 'text':
      case 'thinking':
        if (block.body.case === 'thinking' && role !== 'assistant') throw invalid('thinking requires an assistant message');
        content.push({ type: block.body.case, text: await readText(
          block.body.value,
          reader,
          limits,
          signal,
          budget,
        ) });
        break;
      case 'toolUse': {
        boundedText(block.body.value.toolUseId, 'toolUseId');
        boundedText(block.body.value.capabilityName, 'capabilityName');
        const input = parseJsonObject(
          block.body.value.encodedJsonArguments,
          block.body.value.argumentsSha256,
          limits.maxToolArgumentsBytes,
          'tool arguments',
        );
        budget.add(block.body.value.encodedJsonArguments.byteLength);
        content.push({
          type: 'tool_use',
          id: block.body.value.toolUseId,
          name: block.body.value.capabilityName,
          input,
        });
        break;
      }
      case 'toolResult': {
        boundedText(block.body.value.toolUseId, 'toolUseId');
        const text = await readResult(
          block.body.value,
          reader,
          limits,
          signal,
          budget,
        );
        content.push({
          type: 'tool_result',
          tool_use_id: block.body.value.toolUseId,
          content: text,
          is_error: block.body.value.isError || undefined,
          truncated: block.body.value.truncated || undefined,
          originalSize: optionalSafeNumber(block.body.value.originalBytes, 'originalBytes'),
        });
        break;
      }
      case 'attachment':
        content.push(await readAttachment(block.body.value, reader, limits, signal, budget));
        break;
      case undefined:
        throw invalid('provider content block is empty');
    }
  }
  return {
    role,
    content,
    phase: phaseFromWire(message.phase),
    isMeta: message.isMeta || undefined,
  };
}

function adaptTool(
  tool: agentV1Runtime.ProviderToolDescriptor,
  limits: ProviderGatewayLimits,
  budget: RequestByteBudget,
): ToolSpec {
  boundedText(tool.capabilityName, 'capabilityName');
  budget.add(Buffer.byteLength(tool.description));
  const schema = parseJsonObject(
    tool.encodedJsonSchema,
    tool.schemaSha256,
    limits.maxToolSchemaBytes,
    'tool schema',
  );
  budget.add(tool.encodedJsonSchema.byteLength);
  return { name: tool.capabilityName, description: tool.description, parameters: asJsonSchema(schema) };
}

async function readText(
  content: agentV1Runtime.ProviderTextContent,
  reader: ProviderArtifactReaderPort | undefined,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
  budget: RequestByteBudget,
): Promise<string> {
  if (content.body.case === 'inlineUtf8') {
    budget.add(Buffer.byteLength(content.body.value));
    return content.body.value;
  }
  if (content.body.case !== 'artifact') throw invalid('provider text content is empty');
  const bytes = await readArtifact(content.body.value, reader, limits, signal, budget);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (cause) {
    throw invalid('provider text artifact is not UTF-8', cause);
  }
}

async function readResult(
  result: agentV1Runtime.ProviderToolResultContent,
  reader: ProviderArtifactReaderPort | undefined,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
  budget: RequestByteBudget,
): Promise<string> {
  if (result.content.case === 'inlineUtf8') {
    budget.add(Buffer.byteLength(result.content.value));
    return result.content.value;
  }
  if (result.content.case !== 'artifact') throw invalid('provider tool result is empty');
  const bytes = await readArtifact(result.content.value, reader, limits, signal, budget);
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readAttachment(
  artifact: agentV1Artifact.ArtifactRef,
  reader: ProviderArtifactReaderPort | undefined,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
  budget: RequestByteBudget,
): Promise<ContentBlock> {
  const bytes = await readArtifact(artifact, reader, limits, signal, budget);
  if (artifact.mediaType.startsWith('image/')) {
    return { type: 'image', mediaType: artifact.mediaType, base64: Buffer.from(bytes).toString('base64') };
  }
  const name = artifact.displayName || artifact.artifactId;
  if (isTextMediaType(artifact.mediaType)) {
    return { type: 'document', name, mediaType: artifact.mediaType, text: new TextDecoder().decode(bytes) };
  }
  return { type: 'document', name, mediaType: artifact.mediaType, base64: Buffer.from(bytes).toString('base64') };
}

async function readArtifact(
  artifact: agentV1Artifact.ArtifactRef,
  reader: ProviderArtifactReaderPort | undefined,
  limits: ProviderGatewayLimits,
  signal: AbortSignal,
  budget: RequestByteBudget,
): Promise<Uint8Array> {
  if (!reader) throw invalid('provider artifact reader is unavailable');
  const bytes = await reader.read(artifact, limits.maxArtifactBytes, signal);
  verifyArtifact(artifact, bytes, limits.maxArtifactBytes);
  budget.add(bytes.byteLength);
  return bytes;
}

function optionalSafeNumber(value: bigint | undefined, name: string): number | undefined {
  return value === undefined ? undefined : safeNumber(value, name);
}

function invalid(message: string, cause?: unknown): ProviderGatewayError {
  return new ProviderGatewayError('invalid_provider_request', message, { cause });
}
