import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage, ProviderReplayState } from '@mcp/provider-sdk';
import { verifiedReplayBinding, verifyLegacyReplay } from '@mcp/provider-sdk/replay-binding.js';
import { canonicalJson, type AtomicFileOptions } from './atomic-file.js';
import { assertPathHasNoLinksSync } from './path-safety.js';
import { isDigest, transcriptDigest, writeTranscriptFile } from './transcript-files.js';

export interface ReplayReference {
  sha256: string;
  bytes: number;
  header: Omit<ProviderReplayState, 'items'>;
  legacy_binding?: string;
}
const references = new WeakMap<object, { bundle: string; ref: ReplayReference }>();

export async function saveProviderReplay(bundle: string, state: ProviderReplayState, message: AgentMessage, options: AtomicFileOptions): Promise<ReplayReference> {
  const existing = references.get(state);
  if (existing?.bundle === bundle) return existing.ref;
  const { items: _items, ...header } = state;
  const bytes = Buffer.from(JSON.stringify(state));
  const sha256 = transcriptDigest(bytes);
  const path = join(bundle, 'provider_replay', sha256 + '.json');
  await writeTranscriptFile(bundle, path, bytes, sha256, options);
  const binding = state.messageDigest?.startsWith('v2:') ? null : verifyLegacyReplay(message, state);
  return { sha256, bytes: bytes.length, header, ...(binding ? { legacy_binding: binding } : {}) };
}

export function readProviderReplay(bundle: string, ref: ReplayReference): ProviderReplayState {
  const path = join(bundle, 'provider_replay', ref.sha256 + '.json');
  assertPathHasNoLinksSync(bundle, path);
  const bytes = readFileSync(path);
  if (bytes.length !== ref.bytes || transcriptDigest(bytes) !== ref.sha256) throw new Error('Provider replay checksum mismatch');
  const state = JSON.parse(bytes.toString('utf8')) as ProviderReplayState;
  const { items, ...header } = state;
  if (!Array.isArray(items) || canonicalJson(header) !== canonicalJson(ref.header)) throw new Error('Provider replay header mismatch');
  return state;
}

/** Reading the header, including scope and message digest, performs no replay I/O. */
export function deferredReplayState(bundle: string, ref: ReplayReference): ProviderReplayState {
  if (!isDigest(ref?.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 ||
      ref.header?.format !== 'openai-responses-v1' || typeof ref.header.scope !== 'string' || 'items' in ref.header) {
    throw new Error('Invalid provider replay reference');
  }
  let items: ProviderReplayState['items'] | undefined;
  const state = { ...ref.header, get items() { return items ??= readProviderReplay(bundle, ref).items; } };
  Object.defineProperty(state, verifiedReplayBinding, { value: ref.legacy_binding ?? null });
  references.set(state, { bundle, ref });
  return state;
}
