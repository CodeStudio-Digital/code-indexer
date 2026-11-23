import type { SessionId } from '@mcp/agent-runtime-contracts';

export interface ToolResultLookup {
  getToolResultsByToolUseIds(sessionId: SessionId, ids: readonly string[]): Promise<Array<{
    tool_use_id: string; result_text: string; is_error: boolean;
  }>>;
}

const TRIM_TOOL_RESULT = 4000;

function isSpawnAgentTool(name: unknown): boolean {
  return name === 'spawn_agent' || name === 'spawn_agents';
}

function collectToolNamesByUseId(messages: Array<{ content: unknown[] }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of messages) {
    for (const block of m.content) {
      const b = block as Record<string, unknown>;
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        out.set(b.id, b.name);
      }
    }
  }
  return out;
}

function compactSpawnAgentResult(content: string): string {
  const matches = [...content.matchAll(/^###\s+Agent\s+\d+:\s+.*$/gm)];
  if (matches.length === 0) return content.slice(0, TRIM_TOOL_RESULT);

  const headerStart = matches[0].index ?? 0;
  const header = content.slice(0, headerStart).trimEnd();
  const targetChars = Math.max(TRIM_TOOL_RESULT, 8000);
  const fixedOverhead = header.length + matches.length * 180;
  const bodyBudget = Math.max(260, Math.floor((targetChars - fixedOverhead) / matches.length));

  const sections: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const nextStart = matches[i + 1]?.index ?? content.length;
    const rawSection = content
      .slice(start, nextStart)
      .replace(/\n\s*---\s*$/, '')
      .trim();
    const lines = rawSection.split('\n');
    const title = lines.shift() ?? '';
    const meta = lines.shift() ?? '';
    const body = lines.join('\n').trim();
    const preview =
      body.length > bodyBudget
        ? `${body.slice(0, bodyBudget).trimEnd()}\n\n… [agent report truncated for transport]`
        : body;
    sections.push([title, meta, preview].filter(Boolean).join('\n'));
  }

  const compact = `${header ? `${header}\n\n` : ''}${sections.join('\n\n---\n\n')}`;
  return compact.length < content.length ? compact : content;
}

function trimToolResultContent(content: string, toolName: unknown): string {
  if (content.length <= TRIM_TOOL_RESULT) return content;
  if (isSpawnAgentTool(toolName)) return compactSpawnAgentResult(content);
  return content.slice(0, TRIM_TOOL_RESULT);
}

export function trimMessageBlocks<M extends { role?: string; content: unknown[]; providerReplay?: unknown }>(
  messages: M[],
): Omit<M, 'providerReplay'>[] {
  const toolNamesByUseId = collectToolNamesByUseId(messages);
  return messages.map(({ providerReplay: _providerOnly, ...m }) => {
    // Synthetic tool-image plumbing message (view_image / preview_screenshot →
    // a user/image block). The dashboard renders this image INLINE under the
    // tool call on reload, so keep its base64 (no upload endpoint to re-fetch
    // a tool screenshot, unlike a user upload).
    const isToolImageMsg =
      m.role !== 'assistant' &&
      m.content.some(
        (b) =>
          (b as Record<string, unknown>).type === 'text' &&
          String((b as Record<string, unknown>).text ?? '').trim() ===
            '(Image(s) attached from the tool call above.)',
      );
    return {
    ...m,
    content: m.content.map((block) => {
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > TRIM_TOOL_RESULT) {
        const toolName = typeof b.tool_use_id === 'string' ? toolNamesByUseId.get(b.tool_use_id) : undefined;
        const content = b.content as string;
        const trimmedContent = trimToolResultContent(content, toolName);
        if (trimmedContent.length >= content.length) return b;
        return {
          ...b,
          content: trimmedContent,
          _truncated: true,
          _originalLength: content.length,
        };
      }
      // Preserve assistant-emitted images (e.g. server-managed image_generation
      // results from Codex). Stripping their base64 would lose the image on
      // session reload — there's no upload endpoint to re-fetch them from.
      // User-side image/document uploads still get trimmed: they're stored
      // verbatim and the dashboard fetches them on demand. Tool-produced images
      // (isToolImageMsg) are kept too — rendered inline, no re-fetch path.
      if (
        (b.type === 'image' || b.type === 'document') &&
        typeof b.base64 === 'string' &&
        m.role !== 'assistant' &&
        !isToolImageMsg
      ) {
        const { base64: _omit, ...rest } = b;
        void _omit;
        return { ...rest, _hasBase64: true };
      }
      return b;
    }),
    };
  });
}

/**
 * Read-time status repair: for tool_use blocks whose `tool_result` block is
 * absent from the loaded window, look up the recorded result in the
 * session bundle's tool-call records. The dashboard seeds these into its
 * tool-result map so the call renders its real terminal status instead of a
 * perpetual "loading" spinner. This heals sessions written before the
 * paired-persistence fix (where a mid-run compaction dropped the tool message
 * while the audit row survived). Empty for healthy sessions — every block is
 * already paired — so it adds nothing to the common-case payload.
 */
export async function reconstructMissingToolResults(
  sessionStore: ToolResultLookup,
  sessionId: SessionId,
  messages: Array<{ role?: string; content: unknown }>,
): Promise<Array<{ tool_use_id: string; content: string; is_error: boolean; _truncated?: boolean; _originalLength?: number }>> {
  const useIds = new Set<string>();
  const resIds = new Set<string>();
  const toolNamesByUseId = new Map<string, string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        useIds.add(block.id);
        if (typeof block.name === 'string') toolNamesByUseId.set(block.id, block.name);
      }
      else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') resIds.add(block.tool_use_id);
    }
  }
  const missing = [...useIds].filter((id) => !resIds.has(id));
  if (missing.length === 0) return [];
  return (await sessionStore.getToolResultsByToolUseIds(sessionId, missing)).map((r) => {
    const content =
      r.result_text.length > TRIM_TOOL_RESULT
        ? trimToolResultContent(r.result_text, toolNamesByUseId.get(r.tool_use_id))
        : r.result_text;
    const trimmed = content.length < r.result_text.length;
    return {
      tool_use_id: r.tool_use_id,
      content,
      is_error: r.is_error,
      ...(trimmed ? { _truncated: true, _originalLength: r.result_text.length } : {}),
    };
  });
}
