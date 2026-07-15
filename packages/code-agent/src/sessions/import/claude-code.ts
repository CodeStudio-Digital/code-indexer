import { homedir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { readJsonlHead, readStableJsonl, walkFiles } from './jsonl.js';
import {
  asRecord,
  asText,
  boundedBase64,
  boundedToolResult,
  meaningfulMessage,
  repairToolPairs,
  safeInput,
  transcriptStats,
} from './normalize.js';
import {
  ExternalSessionError,
  type ExternalSessionCandidate,
  type ExternalSessionDocument,
  type ExternalSessionMessage,
  type ExternalSessionReference,
  type ExternalSessionWarning,
} from './types.js';

function timestamp(row: Record<string, unknown>): string | null {
  const value = row.timestamp ?? row.createdAt ?? row.updatedAt;
  if (typeof value === 'number') return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  return typeof value === 'string' ? value : null;
}

function imageBlock(value: Record<string, unknown>): ContentBlock[] {
  const source = asRecord(value.source) ?? value;
  const mediaType = asText(source.media_type ?? source.mediaType) || 'image/png';
  const data = asText(source.data ?? source.base64);
  if (!data) return [];
  const bounded = boundedBase64(data);
  return bounded.base64
    ? [{ type: 'image', mediaType, base64: bounded.base64 }]
    : [{ type: 'text', text: bounded.warning! }];
}

function toolResultText(value: unknown): string {
  if (!Array.isArray(value)) return asText(value);
  return value.map((item) => {
    const block = asRecord(item);
    if (!block) return asText(item);
    if (block.type === 'text') return asText(block.text);
    if (block.type === 'image') {
      const source = asRecord(block.source);
      const bytes = Math.ceil(asText(source?.data).length * 0.75);
      return `[Embedded image in tool result: ${asText(source?.media_type) || 'image'}, ${bytes} bytes]`;
    }
    return asText(item);
  }).filter(Boolean).join('\n');
}

function contentBlocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') return value.trim() ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return value == null ? [] : [{ type: 'text', text: asText(value) }];
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    const block = asRecord(item);
    if (!block) continue;
    const type = asText(block.type);
    if (type === 'thinking' || type === 'redacted_thinking') continue;
    if (type === 'text') {
      const text = asText(block.text);
      if (text) blocks.push({ type: 'text', text });
    } else if (type === 'tool_use') {
      const id = asText(block.id);
      if (id) blocks.push({ type: 'tool_use', id, name: asText(block.name) || 'unknown_tool', input: safeInput(block.input) });
    } else if (type === 'tool_result') {
      const toolUseId = asText(block.tool_use_id);
      if (toolUseId) {
        blocks.push({
          type: 'tool_result',
          tool_use_id: toolUseId,
          ...boundedToolResult(toolResultText(block.content)),
          is_error: block.is_error === true,
        });
      }
    } else if (type === 'image') {
      blocks.push(...imageBlock(block));
    } else if (type === 'document') {
      const name = asText(block.name) || 'attachment';
      const mediaType = asText(block.media_type ?? block.mediaType) || 'application/octet-stream';
      const text = typeof block.text === 'string' ? block.text : undefined;
      const base64 = asText(block.data ?? block.base64);
      const bounded = base64 ? boundedBase64(base64) : {};
      if (bounded.warning) blocks.push({ type: 'text', text: bounded.warning });
      else blocks.push({ type: 'document', name, mediaType, text, base64: bounded.base64 });
    }
  }
  return blocks;
}

function stripClaudeRuntimeText(content: ContentBlock[]): ContentBlock[] {
  return content.flatMap((block): ContentBlock[] => {
    if (block.type !== 'text') return [block];
    const text = block.text
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/gi, '')
      .trim();
    return text ? [{ ...block, text }] : [];
  });
}

function currentBranch(records: unknown[]): Record<string, unknown>[] {
  const rows = records.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
  const byUuid = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const uuid = asText(row.uuid);
    if (uuid) byUuid.set(uuid, row);
  }
  const leafMarker = [...rows].reverse().find((row) => row.type === 'last-prompt' && typeof row.leafUuid === 'string');
  let cursor = asText(leafMarker?.leafUuid);
  if (!cursor) {
    cursor = asText([...rows].reverse().find((row) => byUuid.has(asText(row.uuid)))?.uuid);
  }
  if (!cursor || !byUuid.has(cursor)) return rows;
  const selected = new Set<string>();
  while (cursor && byUuid.has(cursor) && !selected.has(cursor)) {
    selected.add(cursor);
    cursor = asText(byUuid.get(cursor)?.parentUuid);
  }
  return rows.filter((row) => selected.has(asText(row.uuid)) || row.type === 'system');
}

function sourceSummary(records: Record<string, unknown>[]): string | null {
  for (const row of [...records].reverse()) {
    if (row.type !== 'system' || row.subtype !== 'compact_boundary') continue;
    const metadata = asRecord(row.compactMetadata);
    const message = asRecord(row.message);
    const candidate = metadata?.summary ?? row.summary ?? row.content ?? message?.content;
    const text = typeof candidate === 'string' ? candidate : asText(candidate);
    if (text.trim()) return text;
  }
  return null;
}

function toMessages(records: Record<string, unknown>[]): ExternalSessionMessage[] {
  const messages: ExternalSessionMessage[] = [];
  for (const row of records) {
    if (row.type !== 'user' && row.type !== 'assistant') continue;
    const rawMessage = asRecord(row.message);
    if (!rawMessage) continue;
    const rawRole = asText(rawMessage.role || row.type);
    if (rawRole === 'system' || rawRole === 'developer') continue;
    const content = rawRole === 'user'
      ? stripClaudeRuntimeText(contentBlocks(rawMessage.content))
      : contentBlocks(rawMessage.content);
    if (content.length === 0) continue;
    const onlyToolResults = content.every((block) => block.type === 'tool_result');
    const message: AgentMessage = {
      role: onlyToolResults ? 'tool' : rawRole === 'assistant' ? 'assistant' : 'user',
      content,
    };
    if (meaningfulMessage(message)) messages.push({ message, created_at: timestamp(row) });
  }
  return messages;
}

function candidateFromHead(path: string, records: unknown[], size: number, title?: string): ExternalSessionCandidate | null {
  const rows = records.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
  const row = rows.find((item) => typeof item.sessionId === 'string' || typeof item.cwd === 'string');
  if (!row) return null;
  const externalId = asText(row.sessionId) || basename(path, '.jsonl');
  const updated = [...rows].reverse().map(timestamp).find(Boolean) ?? null;
  const modelRow = rows.find((item) => item.type === 'assistant' && asRecord(item.message));
  const sourceModel = asText(asRecord(modelRow?.message)?.model ?? modelRow?.model) || null;
  return {
    source: 'claude-code', external_id: externalId, title: title || `Claude ${externalId.slice(0, 8)}`,
    cwd: asText(row.cwd) || null, updated_at: updated, source_model: sourceModel, source_path: normalize(path),
    size_bytes: size, reference: { source: 'claude-code', source_path: normalize(path), external_id: externalId },
  };
}

async function historyTitles(root: string): Promise<Map<string, string>> {
  const titles = new Map<string, string>();
  try {
    const result = await readStableJsonl(join(root, 'history.jsonl'));
    for (const raw of result.records) {
      const row = asRecord(raw);
      const id = asText(row?.sessionId);
      const display = asText(row?.display ?? row?.title);
      if (id && display) titles.set(id, display.replace(/\s+/g, ' ').trim().slice(0, 160));
    }
  } catch { /* history is only a title index */ }
  return titles;
}

export async function discoverClaudeCode(root = join(homedir(), '.claude')): Promise<ExternalSessionCandidate[]> {
  const titles = await historyTitles(root);
  const paths = await walkFiles(join(root, 'projects'), (name, depth) => depth === 1 && name.endsWith('.jsonl'));
  const candidates: Array<ExternalSessionCandidate | null> = await Promise.all(paths.map(async (path) => {
    try {
      const head = await readJsonlHead(path, 30);
      const raw = candidateFromHead(path, head.records, head.size_bytes);
      return raw ? { ...raw, title: titles.get(raw.external_id) ?? raw.title, updated_at: head.modified_at } : null;
    } catch { return null; }
  }));
  return candidates.filter((value): value is ExternalSessionCandidate => value != null)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

export async function readClaudeCode(reference: ExternalSessionReference): Promise<ExternalSessionDocument> {
  if (normalize(reference.source_path).split(/[\\/]+/).some((part) => part.toLowerCase() === 'subagents')) {
    throw new ExternalSessionError('unsupported_format', 'Claude Code subagent transcripts are not imported as standalone sessions');
  }
  const read = await readStableJsonl(reference.source_path);
  const records = currentBranch(read.records);
  const candidate = candidateFromHead(reference.source_path, records, read.size_bytes);
  if (!candidate) throw new ExternalSessionError('unsupported_format', 'File is not a Claude Code session');
  if (reference.external_id && candidate.external_id !== reference.external_id) {
    throw new ExternalSessionError('unsupported_format', 'Claude session id does not match the selected source');
  }
  const normalized = repairToolPairs(toMessages(records));
  if (normalized.messages.length === 0) throw new ExternalSessionError('empty_transcript', 'Claude session has no importable messages');
  const warnings: ExternalSessionWarning[] = [...read.warnings, ...normalized.warnings];
  return {
    candidate: { ...candidate, reference: { ...candidate.reference, fingerprint: read.fingerprint } },
    messages: normalized.messages,
    source_summary: sourceSummary(records), fingerprint: read.fingerprint,
    stats: transcriptStats(normalized.messages), warnings,
    diagnostics: { adapter: 'claude-code', branch_records: records.length, source_records: read.records.length },
  };
}
