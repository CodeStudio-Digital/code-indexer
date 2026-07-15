import { readJsonlHead } from './jsonl.js';
import { asRecord } from './normalize.js';
import { discoverClaudeCode, readClaudeCode } from './claude-code.js';
import { discoverCodex, readCodex } from './codex.js';
import {
  ExternalSessionError,
  type ExternalSessionCandidate, type ExternalSessionDocument, type ExternalSessionPreview,
  type ExternalSessionReference, type ExternalSessionSource,
} from './types.js';

export interface ExternalSessionAdapter {
  source: ExternalSessionSource;
  discover(): Promise<ExternalSessionCandidate[]>;
  read(reference: ExternalSessionReference): Promise<ExternalSessionDocument>;
}

const adapters = new Map<ExternalSessionSource, ExternalSessionAdapter>();

export function registerExternalSessionAdapter(adapter: ExternalSessionAdapter): void {
  adapters.set(adapter.source, adapter);
}

registerExternalSessionAdapter({ source: 'claude-code', discover: discoverClaudeCode, read: readClaudeCode });
registerExternalSessionAdapter({ source: 'codex', discover: discoverCodex, read: readCodex });

export function getExternalSessionAdapter(source: ExternalSessionSource): ExternalSessionAdapter {
  const adapter = adapters.get(source);
  if (!adapter) throw new ExternalSessionError('unsupported_format', `Unsupported external session source: ${source}`);
  return adapter;
}

export async function detectExternalSessionSource(path: string): Promise<ExternalSessionSource> {
  const head = await readJsonlHead(path, 30);
  for (const raw of head.records) {
    const row = asRecord(raw);
    if (!row) continue;
    if (row.type === 'session_meta') return 'codex';
    if (typeof row.sessionId === 'string' && (row.type === 'user' || row.type === 'assistant' || row.type === 'system')) return 'claude-code';
  }
  throw new ExternalSessionError('unsupported_format', 'JSONL is neither a Claude Code session nor a Codex rollout');
}

export async function readExternalSession(reference: ExternalSessionReference): Promise<ExternalSessionDocument> {
  const source = reference.source ?? await detectExternalSessionSource(reference.source_path);
  const document = await getExternalSessionAdapter(source).read({ ...reference, source });
  if (reference.fingerprint && document.fingerprint !== reference.fingerprint) {
    throw new ExternalSessionError('source_busy', 'Source changed after preview; preview it again');
  }
  return document;
}

export function previewExternalSession(document: ExternalSessionDocument): ExternalSessionPreview {
  return {
    ...document.candidate,
    fingerprint: document.fingerprint,
    has_source_summary: Boolean(document.source_summary),
    stats: document.stats,
    warnings: document.warnings,
    reference: { ...document.candidate.reference, fingerprint: document.fingerprint },
  };
}

export async function discoverExternalSessions(source?: ExternalSessionSource): Promise<ExternalSessionCandidate[]> {
  const selected = source ? [getExternalSessionAdapter(source)] : [...adapters.values()];
  const groups = await Promise.all(selected.map((adapter) => adapter.discover()));
  return groups.flat().sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}
