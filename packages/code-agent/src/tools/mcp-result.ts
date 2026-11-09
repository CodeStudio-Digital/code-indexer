import type { ExternalMcpContent } from './mcp-content-types.js';
import type { ContentBlock } from '@mcp/code-agent/core/messages.js';
import type { ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';
import { normalizeSourceTruncations } from '@mcp/code-agent/core/runner/tool-output-telemetry.js';

/** Shared adaptation for internal and external MCP responses, including errors. */
export function mcpResultToToolResult(result: { content?: unknown; structuredContent?: unknown; isError?: boolean; _meta?: Record<string, unknown> }, toolName: string): ToolResult {
  const blocks = (Array.isArray(result.content) ? result.content : []) as ExternalMcpContent[];
  let unsupported = 0;
  const textParts: string[] = [];
  const extraUserBlocks: ContentBlock[] = [];

  for (const block of blocks) {
    if (!block || typeof block !== 'object') { unsupported++; continue; }
    if (block.type === 'text' && typeof block.text === 'string') {
    textParts.push(block.text);
    continue;
    }
    if (block.type === 'image' && typeof block.data === 'string') {
    extraUserBlocks.push({
      type: 'image',
      mediaType: block.mimeType || 'image/png',
      base64: block.data,
    });
    continue;
    }
    if (block.type === 'audio' && typeof block.data === 'string') {
    extraUserBlocks.push({
      type: 'document',
      name: `${toolName}-audio`,
      mediaType: block.mimeType || 'audio/mpeg',
      base64: block.data,
    });
    continue;
    }
    if (block.type === 'resource' && block.resource) {
    const resource = block.resource;
    const mediaType = resource.mimeType || 'application/octet-stream';
    if (typeof resource.blob === 'string' && mediaType.startsWith('image/')) {
      extraUserBlocks.push({ type: 'image', mediaType, base64: resource.blob });
    } else {
      extraUserBlocks.push({
      type: 'document',
      name: resource.uri || `${toolName}-resource`,
      mediaType,
      text: resource.text,
      base64: resource.blob,
      });
    }
    continue;
    }
    if (block.type === 'resource_link' && typeof block.uri === 'string') {
    textParts.push(`[resource] ${block.name ? `${block.name}: ` : ''}${block.uri}`);
      continue;
    }
    unsupported++;
  }

  const structuredData = result.structuredContent;
  // Remote output references belong to the remote host. This adapter has no
  // local recovery capability for them, even when the server advertises one.
  const truncations = normalizeSourceTruncations(result._meta?.sourceTruncations).map(({ outputId: _remoteId, ...cut }) => ({ ...cut, recoverable: false }));
  if (unsupported) {
    textParts.push(`[${unsupported} unsupported content blocks omitted]`);
    truncations.push({ technique: 'unsupported-mcp-block', inputSize: blocks.length, outputSize: blocks.length - unsupported, unit: 'items', recoverable: false });
  }
  if (textParts.length === 0 && structuredData !== undefined) {
    textParts.push(JSON.stringify(structuredData));
  }
  if (textParts.length === 0 && extraUserBlocks.length > 0) {
    textParts.push(
    `External MCP tool returned ${extraUserBlocks.length} attachment` +
    `${extraUserBlocks.length === 1 ? '' : 's'}.`,
    );
  }
  const text = textParts.join('\n') || 'External MCP tool returned no content.';
  const base = result.isError ? err(text) : ok(text);
  return {
    ...base,
    ...(truncations.length ? { sourceTruncations: truncations } : {}),
    ...(structuredData !== undefined ? { structuredData } : {}),
    ...(extraUserBlocks.length > 0 ? { extraUserBlocks } : {}),
    ...(textParts.length === 1 && structuredData !== undefined && blocks.length === 0
    ? { contentFormat: 'json' as const }
    : {}),
  };
}
