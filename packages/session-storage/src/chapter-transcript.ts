import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteFile, canonicalJson, fsyncDirectory, type AtomicFileOptions } from './atomic-file.js';
import { assertPathHasNoLinks, assertPathHasNoLinksSync } from './path-safety.js';
import { CODER_JOURNAL } from './session-journal-path.js';
import { writeTranscriptFile } from './transcript-files.js';
import { isUuid, type ConversationCommit, type JsonValue } from './types.js';
import type { AgentMessage, ProviderReplayState } from '@mcp/provider-sdk';
import { ChapterRecordReader, packChapterRecords, type JournalLine } from './chapter-records.js';
import { deferredReplayState, saveProviderReplay, type ReplayReference } from './provider-replay-file.js';

export interface ChapterSpan { id: string; start_message_seq: number; end_message_seq: number }
type Collection = 'messages' | 'message_patches';
interface Row { seq: number; content?: JsonValue; provider_replay?: ProviderReplayState; provider_replay_ref?: ReplayReference }
interface Rows { type: string; messages: Row[]; message_patches: Row[]; tool_calls: { message_seq: number }[] }
interface Source {
  collection: Collection; index: number; chapter: string; file: string; offset: number; length: number; sha256: string;
}
interface PackedCommit extends ConversationCommit {
  chapter_sources?: Source[];
  storage_hash?: string;
}
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const collections = ['messages', 'message_patches'] as const;
type CommitIdentity = Pick<ConversationCommit, 'seq' | 'hash'>;
const sourceByField = new WeakMap<object, { bundle: string; source: Source; legacy?: CommitIdentity }>();

function recordPayload(commit: ConversationCommit): Rows {
  return commit.payload as unknown as Rows;
}

function archivePath(bundle: string, source: Source): string {
  if (!isUuid(source.chapter) || !hex.test(source.file) || !hex.test(source.sha256) ||
      !Number.isSafeInteger(source.offset) || source.offset < 0 ||
      !Number.isSafeInteger(source.length) || source.length < 1 ||
      !Number.isSafeInteger(source.offset + source.length)) throw new Error('Invalid chapter transcript reference');
  return join(bundle, 'chapters', source.chapter, `messages-${source.file}.ndjson`);
}

/** Full integrity reads reuse one archive buffer; expanding a page reads only its byte ranges. */
export class ChapterArchiveReader extends ChapterRecordReader {
  private last?: { path: string; bytes: Buffer };

  read(bundle: string, source: Source, wholeFile = false, legacy?: CommitIdentity): Row {
    try { return this.readRow(bundle, source, wholeFile); }
    catch (error) {
      if (!legacy || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // An already-open legacy view can outlive the migration. Its original
      // commit identity selects exactly the same row from the published generation.
      const journal = join(bundle, CODER_JOURNAL);
      assertPathHasNoLinksSync(bundle, journal);
      const line = readFileSync(journal, 'utf8').split('\n', legacy.seq)[legacy.seq - 1];
      if (!line) throw error;
      const physical = JSON.parse(line) as JournalLine;
      if (!('chapter_record' in physical)) throw error;
      const replacement = decodeChapterCommit(physical, bundle, 'full', new ChapterArchiveReader()).commit;
      if (replacement.hash !== legacy.hash || replacement.seq !== legacy.seq) throw error;
      const row = recordPayload(replacement)[source.collection]?.[source.index];
      if (!row) throw error;
      return row;
    }
  }

  private readRow(bundle: string, source: Source, wholeFile: boolean): Row {
    const path = archivePath(bundle, source);
    let bytes: Buffer;
    if (wholeFile) {
      if (this.last?.path !== path) {
        assertPathHasNoLinksSync(bundle, path);
        this.last = { path, bytes: readFileSync(path) };
      }
      bytes = this.last.bytes.subarray(source.offset, source.offset + source.length);
    } else {
      assertPathHasNoLinksSync(bundle, path);
      const fd = openSync(path, 'r');
      try {
        if (source.offset + source.length > fstatSync(fd).size) throw new Error('Incomplete chapter transcript');
        bytes = Buffer.allocUnsafe(source.length);
        for (let n = 0; n < bytes.length;) {
          const count = readSync(fd, bytes, n, bytes.length - n, source.offset + n);
          if (!count) throw new Error('Incomplete chapter transcript');
          n += count;
        }
      } finally { closeSync(fd); }
    }
    if (bytes.length !== source.length || digest(bytes) !== source.sha256) throw new Error('Chapter transcript checksum mismatch');
    return JSON.parse(bytes.toString('utf8')) as Row;
  }
}

function provenance(field: unknown) {
  return field && typeof field === 'object' ? sourceByField.get(field) : undefined;
}

/** The content array follows later patches. Provider replay always belongs to the original message. */
export function materializeChapterMessage<T extends { content: JsonValue; provider_replay?: unknown }>(message: T): T {
  const content = provenance(message.content);
  const replay = provenance(message.provider_replay);
  if (!content && !replay) return message;
  const reader = new ChapterArchiveReader();
  const row = content ? reader.read(content.bundle, content.source, false, content.legacy) : undefined;
  const replayRow = replay === content ? row : replay ? reader.read(replay.bundle, replay.source, false, replay.legacy) : undefined;
  return { ...message, ...(row ? { content: row.content } : {}),
    ...(replayRow ? { provider_replay: replayRow.provider_replay } : {}) };
}

/** Keep fields used by outcome reconciliation and artifact GC available without loading an archive. */
function metadata(row: Row): Row {
  const result = { ...row };
  if (row.provider_replay !== undefined) result.provider_replay = {} as ProviderReplayState;
  if (Array.isArray(row.content)) result.content = row.content.map((block: JsonValue) => {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;
    const obj = block as Record<string, JsonValue>;
    if (obj.type === 'tool_use' || obj.type === 'tool_result_ref' || obj.type === 'artifact_ref') return obj;
    if (obj.type === 'tool_result') {
      const { content: _body, ...receipt } = obj;
      return receipt;
    }
    return typeof obj.type === 'string' ? { type: obj.type } : null;
  });
  return result;
}

export function decodeChapterCommit(
  line: JournalLine, bundle: string, mode: 'full' | 'metadata', reader: ChapterArchiveReader,
): { commit: ConversationCommit; metadataOnly: boolean } {
  const raw: PackedCommit = reader.resolve(bundle, line);
  if (raw.chapter_sources === undefined && raw.storage_hash === undefined) return { commit: raw, metadataOnly: false };
  const { storage_hash, ...wire } = raw;
  if ((wire.chapter_sources !== undefined && !Array.isArray(wire.chapter_sources)) ||
      storage_hash !== digest(canonicalJson(wire))) throw new Error('Chapter transcript index checksum mismatch');
  const { chapter_sources, ...commit } = wire;
  const payload = recordPayload(commit);
  const legacy = 'chapter_record' in line ? undefined : { seq: commit.seq, hash: commit.hash };
  const seen = new Set<string>();
  for (const source of chapter_sources ?? []) {
    const key = source.collection + ':' + source.index;
    if (!collections.includes(source.collection) || !Number.isSafeInteger(source.index) || source.index < 0 ||
        !payload[source.collection]?.[source.index] || seen.has(key)) throw new Error('Invalid chapter transcript row');
    seen.add(key);
    archivePath(bundle, source);
    const row = payload[source.collection][source.index]!;
    if (mode === 'full') {
      const original = reader.read(bundle, source, true, legacy);
      if (original.seq !== row.seq) throw new Error('Chapter transcript sequence mismatch');
      payload[source.collection][source.index] = original;
    } else {
      const origin = { bundle, source, legacy };
      for (const field of [row.content, row.provider_replay]) {
        if (field && typeof field === 'object') sourceByField.set(field, origin);
      }
    }
  }
  let detached = false;
  for (const collection of collections) for (const row of payload[collection] ?? []) {
    if (row.provider_replay_ref) {
      row.provider_replay = deferredReplayState(bundle, row.provider_replay_ref);
      delete row.provider_replay_ref;
      detached = true;
    }
  }
  if (!detached && !chapter_sources?.length) throw new Error('Empty packed journal record');
  return { commit, metadataOnly: detached || mode === 'metadata' };
}

/** Called while the old index still exists, after the new journal has been recovered.
 * Only remove exact old content-addressed files for which the new generation has a replacement. */
export async function retireLegacyChapterPacks(bundle: string, previous: string, fence?: () => void | Promise<void>) {
  if (!previous.includes('"chapter_sources":[')) return;
  const first = previous.slice(0, previous.indexOf('\n'));
  if (!first || !first.includes('"operation_id"')) return;
  const old = new Map<string, string>();
  const identities = new Map<number, string>();
  for (const line of previous.trimEnd().split('\n')) {
    const record = JSON.parse(line) as PackedCommit;
    if (record.schema_version !== 1 || !hex.test(record.hash)) return;
    identities.set(record.seq, record.hash);
    for (const src of record.chapter_sources ?? []) old.set(archivePath(bundle, src), src.file);
  }
  if (!old.size) return;
  const reader = new ChapterRecordReader();
  const journal = join(bundle, CODER_JOURNAL);
  await assertPathHasNoLinks(bundle, journal);
  for (const line of (await readFile(journal, 'utf8')).trimEnd().split('\n')) {
    if (!line) continue;
    const record: PackedCommit = reader.resolve(bundle, JSON.parse(line));
    if (identities.has(record.seq) && identities.get(record.seq) !== record.hash) return;
    identities.delete(record.seq);
    for (const src of record.chapter_sources ?? []) old.delete(archivePath(bundle, src));
  }
  if (identities.size) return;
  for (const [path, hash] of old) {
    try {
      await assertPathHasNoLinks(bundle, path);
      if (digest(await readFile(path)) !== hash) throw new Error('Legacy chapter checksum mismatch');
      await fence?.();
      await unlink(path);
      await fsyncDirectory(dirname(path));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

function stamp(commit: PackedCommit) {
  delete commit.storage_hash;
  commit.storage_hash = digest(canonicalJson(commit));
}

/** Copy only the changed parts. Keep the in-memory logical commit and its original hash intact. */
export async function detachCommitReplay(bundle: string, commit: ConversationCommit, options: AtomicFileOptions): Promise<PackedCommit> {
  const original = recordPayload(commit);
  if (original?.type !== 'coder.turn' || !original.messages.some(row => row.provider_replay)) return commit;
  const messages = await Promise.all(original.messages.map(async row => {
    if (!row.provider_replay) return row;
    const { provider_replay, ...rest } = row;
    return { ...rest, provider_replay_ref: await saveProviderReplay(bundle, provider_replay, row as unknown as AgentMessage, options) };
  }));
  const packed = { ...commit, payload: { ...original, messages } as unknown as JsonValue };
  stamp(packed);
  return packed;
}

/** Publish immutable chapter rows first. Replacing the journal is the single commit point. */
export async function archiveChapterMessages(
  path: string, spans: readonly ChapterSpan[], options: AtomicFileOptions, beforeSwitch: () => Promise<void>,
  initial?: readonly ConversationCommit[], onProgress?: () => void,
): Promise<boolean> {
  const bundle = dirname(path);
  let lines: string[] = [];
  if (initial) {
    // Limit the number of outstanding sidecar fsyncs during a legacy migration.
    for (let i = 0; i < initial.length; i += 8) {
      lines.push(...await Promise.all(initial.slice(i, i + 8).map(async c => JSON.stringify(await detachCommitReplay(bundle, c, options)))));
      onProgress?.();
    }
  } else {
    const text = await readFile(path, 'utf8');
    if (!text) return false;
    if (!text.endsWith('\n')) throw new Error('Cannot archive an uncommitted journal suffix');
    lines = text.slice(0, -1).split('\n');
  }
  const changed = await packChapterLines(bundle, spans, lines, options, onProgress);
  if (!changed && !initial) return false;
  await atomicWriteFile(path, lines.length ? lines.join('\n') + '\n' : '', { ...options, beforePublish: beforeSwitch });
  return true;
}

/** Also used for late edits or tool records targeting an already archived message. */
export async function packChapterLines(bundle: string, spans: readonly ChapterSpan[], lines: string[], options: AtomicFileOptions, onProgress?: () => void) {
  const sorted = [...spans].sort((a, b) => a.end_message_seq - b.end_message_seq);
  for (const s of sorted) {
    if (!isUuid(s.id) || !Number.isSafeInteger(s.start_message_seq) || !Number.isSafeInteger(s.end_message_seq) ||
        s.start_message_seq < 1 || s.end_message_seq < s.start_message_seq) throw new Error('Invalid chapter message span');
  }
  const archives = new Map<string, { chunks: Buffer[]; sources: Source[]; size: number }>();
  const changed = new Map<number, PackedCommit>();
  const owners = new Map<number, string>();
  const records = new ChapterRecordReader();
  let lastSeq = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const raw = JSON.parse(line) as JournalLine;
    const commit: PackedCommit = records.resolve(bundle, raw);
    const payload = recordPayload(commit);
    if (payload?.type !== 'coder.turn') continue;
    for (const row of payload.messages) lastSeq = Math.max(lastSeq, row.seq);
    const seq = payload.messages[0]?.seq ?? payload.message_patches[0]?.seq ?? payload.tool_calls[0]?.message_seq ?? lastSeq;
    const owner = sorted.find(s => seq >= s.start_message_seq && seq <= s.end_message_seq);
    if (owner && !('chapter_record' in raw)) owners.set(lineIndex, owner.id);
    const existing = new Set(commit.chapter_sources?.map(s => s.collection + ':' + s.index));
    for (const collection of collections) {
      for (const [index, row] of payload[collection].entries()) {
        if (existing.has(collection + ':' + index) || (row.content === undefined && row.provider_replay === undefined)) continue;
        const chapter = sorted.find(s => row.seq >= s.start_message_seq && row.seq <= s.end_message_seq);
        if (!chapter) continue;
        let archive = archives.get(chapter.id);
        if (!archive) { archive = { chunks: [], sources: [], size: 0 }; archives.set(chapter.id, archive); }
        const bytes = Buffer.from(JSON.stringify(row), 'utf8');
        const source: Source = { collection, index, chapter: chapter.id, file: '', offset: archive.size,
          length: bytes.length, sha256: digest(bytes) };
        archive.chunks.push(bytes, Buffer.from('\n'));
        archive.size += bytes.length + 1;
        archive.sources.push(source);
        (commit.chapter_sources ??= []).push(source);
        payload[collection][index] = metadata(row);
        changed.set(lineIndex, commit);
        owners.set(lineIndex, owner?.id ?? chapter.id);
      }
    }
  }
  if (!changed.size && !owners.size) return false;
  for (const archive of archives.values()) {
    const bytes = Buffer.concat(archive.chunks);
    const file = digest(bytes);
    for (const src of archive.sources) src.file = file;
    const target = archivePath(bundle, archive.sources[0]!);
    await writeTranscriptFile(bundle, target, bytes, file, options);
    onProgress?.();
  }
  for (const [i, commit] of changed) {
    stamp(commit);
    lines[i] = JSON.stringify(commit);
  }
  const groups = new Map<string, Map<number, string>>();
  for (const [i, chapter] of owners) {
    let group = groups.get(chapter);
    if (!group) groups.set(chapter, group = new Map());
    group.set(i, lines[i]!);
  }
  for (const [chapter, group] of groups) {
    await packChapterRecords(bundle, chapter, group, lines, options);
    onProgress?.();
  }
  return true;
}
