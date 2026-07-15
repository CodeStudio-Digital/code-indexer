import { homedir } from 'node:os';
import { basename, join, normalize } from 'node:path';
import type { AgentMessage, ContentBlock } from '@mcp/code-agent/core/messages.js';
import { readJsonlHead, readStableJsonl, walkFiles } from './jsonl.js';
import {
  asRecord, asText, boundedBase64, boundedToolResult, meaningfulMessage,
  repairToolPairs, safeInput, transcriptStats,
} from './normalize.js';
import {
  ExternalSessionError,
  type ExternalSessionCandidate, type ExternalSessionDocument, type ExternalSessionMessage,
  type ExternalSessionReference, type ExternalSessionWarning,
} from './types.js';

function payload(row: Record<string, unknown>): Record<string, unknown> {
  return asRecord(row.payload) ?? row;
}

function timestamp(row: Record<string, unknown>): string | null {
  const value = row.timestamp ?? row.created_at ?? payload(row).timestamp;
  if (typeof value === 'number') return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
  return typeof value === 'string' ? value : null;
}

function messageBlocks(value: unknown): ContentBlock[] {
  if (typeof value === 'string') return value.trim() ? [{ type: 'text', text: value }] : [];
  if (!Array.isArray(value)) return [];
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    const block = asRecord(item);
    if (!block) continue;
    const type = asText(block.type);
    if (type === 'input_text' || type === 'output_text' || type === 'text') {
      const text = asText(block.text);
      if (text) blocks.push({ type: 'text', text });
    } else if (type === 'input_image' || type === 'image') {
      const dataUrl = asText(block.image_url ?? block.url ?? block.data);
      const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
      const base64 = match?.[2] ?? asText(block.base64);
      if (!base64) continue;
      const bounded = boundedBase64(base64);
      blocks.push(bounded.base64
        ? { type: 'image', mediaType: match?.[1] ?? (asText(block.media_type) || 'image/png'), base64: bounded.base64 }
        : { type: 'text', text: bounded.warning! });
    }
  }
  return blocks;
}

function isRuntimeEnvelope(blocks: ContentBlock[]): boolean {
  const text = blocks.filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.trim()).join('\n');
  return /^<(environment_context|app-context|permissions instructions|collaboration_mode|skills_instructions)>[\s\S]*<\/[^>]+>\s*$/.test(text);
}

function parseResponseItem(row: Record<string, unknown>): ExternalSessionMessage | null {
  const item = payload(row);
  const type = asText(item.type);
  const createdAt = timestamp(row);
  let message: AgentMessage | null = null;
  if (type === 'message') {
    const role = asText(item.role);
    if (role !== 'user' && role !== 'assistant') return null;
    const content = messageBlocks(item.content);
    if (!content.length || (role === 'user' && isRuntimeEnvelope(content))) return null;
    message = { role, content };
  } else if (type === 'function_call' || type === 'custom_tool_call') {
    const id = asText(item.call_id ?? item.id);
    if (!id) return null;
    message = { role: 'assistant', content: [{
      type: 'tool_use', id, name: asText(item.name) || (type === 'custom_tool_call' ? 'custom_tool' : 'unknown_tool'),
      input: safeInput(item.arguments ?? item.input),
    }] };
  } else if (type === 'function_call_output' || type === 'custom_tool_call_output') {
    const id = asText(item.call_id ?? item.id);
    if (!id) return null;
    message = { role: 'tool', content: [{
      type: 'tool_result', tool_use_id: id, ...boundedToolResult(asText(item.output)),
    }] };
  }
  return message && meaningfulMessage(message) ? { message, created_at: createdAt } : null;
}

function sourceSummary(records: unknown[]): string | null {
  for (const raw of [...records].reverse()) {
    const row = asRecord(raw);
    if (!row) continue;
    const data = payload(row);
    if (row.type === 'compacted') {
      const value = data.message ?? data.summary;
      const text = asText(value);
      if (text.trim()) return text;
    }
    if (row.type === 'turn_context') {
      const text = asText(data.summary);
      if (text.trim()) return text;
    }
  }
  return null;
}

function metaFromRecords(path: string, records: unknown[], size: number, title?: string): ExternalSessionCandidate | null {
  const rows = records.map(asRecord).filter((row): row is Record<string, unknown> => row != null);
  const metaRow = rows.find((row) => row.type === 'session_meta');
  if (!metaRow) return null;
  const meta = payload(metaRow);
  if (asRecord(meta.source)?.subagent != null) return null;
  const externalId = asText(meta.id ?? meta.session_id) || basename(path, '.jsonl');
  const context = [...rows].reverse().find((row) => row.type === 'turn_context');
  const contextPayload = context ? payload(context) : null;
  return {
    source: 'codex', external_id: externalId, title: title || `Codex ${externalId.slice(0, 8)}`,
    cwd: asText(contextPayload?.cwd ?? meta.cwd) || null,
    updated_at: [...rows].reverse().map(timestamp).find(Boolean) ?? null,
    source_model: asText(contextPayload?.model ?? meta.model ?? meta.model_provider) || null,
    source_path: normalize(path), size_bytes: size,
    reference: { source: 'codex', source_path: normalize(path), external_id: externalId },
  };
}

async function indexTitles(root: string): Promise<Map<string, { title: string; updated_at: string | null }>> {
  const titles = new Map<string, { title: string; updated_at: string | null }>();
  try {
    const read = await readStableJsonl(join(root, 'session_index.jsonl'));
    for (const raw of read.records) {
      const row = asRecord(raw);
      const id = asText(row?.id);
      if (!id) continue;
      titles.set(id, { title: asText(row?.thread_name) || `Codex ${id.slice(0, 8)}`, updated_at: asText(row?.updated_at) || null });
    }
  } catch { /* optional title index */ }
  return titles;
}

export async function discoverCodex(root = join(homedir(), '.codex')): Promise<ExternalSessionCandidate[]> {
  const titles = await indexTitles(root);
  const paths = await walkFiles(join(root, 'sessions'), (name) => name.startsWith('rollout-') && name.endsWith('.jsonl'), 6);
  const candidates: Array<ExternalSessionCandidate | null> = await Promise.all(paths.map(async (path) => {
    try {
      const head = await readJsonlHead(path, 20);
      const candidate = metaFromRecords(path, head.records, head.size_bytes);
      if (!candidate) return null;
      const indexed = titles.get(candidate.external_id);
      return indexed
        ? { ...candidate, title: indexed.title, updated_at: indexed.updated_at ?? head.modified_at }
        : { ...candidate, updated_at: head.modified_at };
    } catch { return null; }
  }));
  return candidates.filter((value): value is ExternalSessionCandidate => value != null)
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

export async function readCodex(reference: ExternalSessionReference): Promise<ExternalSessionDocument> {
  const read = await readStableJsonl(reference.source_path);
  const candidate = metaFromRecords(reference.source_path, read.records, read.size_bytes);
  if (!candidate) throw new ExternalSessionError('unsupported_format', 'File is not an importable main Codex rollout session');
  if (reference.external_id && candidate.external_id !== reference.external_id) {
    throw new ExternalSessionError('unsupported_format', 'Codex session id does not match the selected source');
  }
  const dedup = new Set<string>();
  const rawMessages: ExternalSessionMessage[] = [];
  let unknownItems = 0;
  for (const raw of read.records) {
    const row = asRecord(raw);
    if (!row || row.type !== 'response_item') continue;
    const item = payload(row);
    if (item.type === 'reasoning') continue;
    const parsed = parseResponseItem(row);
    if (!parsed) { if (item.type !== 'message') unknownItems += 1; continue; }
    const identity = asText(item.call_id ?? item.id);
    if (identity) {
      const key = `${asText(item.type)}:${identity}`;
      if (dedup.has(key)) continue;
      dedup.add(key);
    }
    rawMessages.push(parsed);
  }
  const normalized = repairToolPairs(rawMessages);
  if (normalized.messages.length === 0) throw new ExternalSessionError('empty_transcript', 'Codex session has no importable messages');
  const warnings: ExternalSessionWarning[] = [...read.warnings, ...normalized.warnings];
  if (unknownItems) warnings.push({ code: 'unknown_response_items', message: `${unknownItems} unknown response item(s) were ignored`, count: unknownItems });
  return {
    candidate: { ...candidate, reference: { ...candidate.reference, fingerprint: read.fingerprint } },
    messages: normalized.messages, source_summary: sourceSummary(read.records), fingerprint: read.fingerprint,
    stats: transcriptStats(normalized.messages), warnings,
    diagnostics: { adapter: 'codex', source_records: read.records.length, ignored_event_stream: true },
  };
}
