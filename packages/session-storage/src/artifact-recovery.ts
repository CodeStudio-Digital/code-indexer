import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  readFile,
  readdir,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  SESSION_ARTIFACT_ROOTS,
  toolOutputRecordFileName,
} from './artifact-store.js';
import { fsyncDirectory } from './atomic-file.js';
import {
  assertContainedPath,
  assertPathHasNoLinks,
  UnsafeSessionPathError,
} from './path-safety.js';
import type {
  ArtifactKind,
  ArtifactRef,
  SessionId,
  SessionStorageFaultInjector,
} from './types.js';

const SHA256 = /^[0-9a-f]{64}$/;
const SHARD = /^[0-9a-f]{2}$/;
const ARTIFACT_KINDS = new Set<ArtifactKind>(
  Object.keys(SESSION_ARTIFACT_ROOTS) as ArtifactKind[],
);
const UTF8 = new TextDecoder('utf-8', { fatal: true });

interface ReferencedArtifact {
  readonly ref: ArtifactRef;
  readonly source: string;
}

interface PendingToolOutputMetadata {
  readonly path: string;
  readonly call_id: string;
  readonly references: ReadonlyMap<string, ReferencedArtifact>;
  readonly standalone: boolean;
}

export interface ArtifactRecoveryResult {
  readonly metadata_files: number;
  readonly referenced_blobs: number;
  readonly scanned_blobs: number;
  readonly removed_tool_records: number;
  readonly removed_blobs: number;
}

export class ArtifactRecoveryCorruptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactRecoveryCorruptionError';
  }
}

function pathKey(path: string): string {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function validateArtifactRef(
  value: Record<string, unknown>,
  source: string,
): ArtifactRef {
  if (
    typeof value.kind !== 'string' ||
    !ARTIFACT_KINDS.has(value.kind as ArtifactKind) ||
    typeof value.sha256 !== 'string' ||
    !SHA256.test(value.sha256) ||
    value.artifact_id !== `sha256:${value.sha256}` ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0 ||
    typeof value.relative_path !== 'string' ||
    !(
      value.media_type === null ||
      typeof value.media_type === 'string'
    ) ||
    !(
      value.logical_name === null ||
      typeof value.logical_name === 'string'
    )
  ) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid ArtifactRef in ${source}`,
    );
  }
  const kind = value.kind as ArtifactKind;
  const expected = [
    ...SESSION_ARTIFACT_ROOTS[kind],
    value.sha256.slice(0, 2),
    value.sha256,
  ].join('/');
  if (
    value.relative_path !== expected ||
    value.relative_path.includes('\\') ||
    value.relative_path.includes('\0')
  ) {
    throw new ArtifactRecoveryCorruptionError(
      `ArtifactRef path does not match its kind/hash in ${source}`,
    );
  }
  return value as unknown as ArtifactRef;
}

function collectRequiredArtifactRef(
  value: unknown,
  source: string,
  references: Map<string, ReferencedArtifact>,
): void {
  if (!isObject(value)) {
    throw new ArtifactRecoveryCorruptionError(
      `Missing or invalid ArtifactRef in ${source}`,
    );
  }
  const ref = validateArtifactRef(value, source);
  const previous = references.get(ref.relative_path);
  if (
    previous &&
    (previous.ref.sha256 !== ref.sha256 ||
      previous.ref.size !== ref.size ||
      previous.ref.kind !== ref.kind)
  ) {
    throw new ArtifactRecoveryCorruptionError(
      `Conflicting ArtifactRef metadata for ${ref.relative_path}`,
    );
  }
  references.set(ref.relative_path, { ref, source });
}

function collectArtifactRefArray(
  value: unknown,
  source: string,
  references: Map<string, ReferencedArtifact>,
): void {
  if (!Array.isArray(value)) {
    throw new ArtifactRecoveryCorruptionError(
      `ArtifactRef collection is not an array in ${source}`,
    );
  }
  value.forEach((item, index) =>
    collectRequiredArtifactRef(item, `${source}[${index}]`, references),
  );
}

function collectToolOutputRefs(
  value: unknown,
  source: string,
  references: Map<string, ReferencedArtifact>,
): string {
  if (!isObject(value)) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid tool output metadata in ${source}`,
    );
  }
  if (
    typeof value.call_id !== 'string' ||
    value.call_id.length === 0
  ) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid tool output call_id in ${source}`,
    );
  }
  for (const field of ['raw', 'shaped'] as const) {
    if (value[field] !== null) {
      collectRequiredArtifactRef(
        value[field],
        `${source}.${field}`,
        references,
      );
    }
  }
  return value.call_id;
}

/**
 * Conversation payloads contain user-controlled tool args and message JSON.
 * Only schema-owned ArtifactRef positions are inspected; an arbitrary
 * `artifact_id: "sha256:..."` in user data is never interpreted as storage
 * metadata.
 */
function collectConversationRefs(
  value: unknown,
  source: string,
  references: Map<string, ReferencedArtifact>,
  referencedToolCallIds: Set<string>,
): void {
  if (!isObject(value)) {
    throw new ArtifactRecoveryCorruptionError(
      `Conversation record is not an object in ${source}`,
    );
  }
  collectArtifactRefArray(value.artifacts, `${source}.artifacts`, references);
  const payload = value.payload;
  if (!isObject(payload) || payload.type !== 'coder.turn') return;

  for (const collection of ['messages', 'message_patches'] as const) {
    const rows = payload[collection];
    if (!Array.isArray(rows)) {
      throw new ArtifactRecoveryCorruptionError(
        `Invalid coder turn ${collection} in ${source}`,
      );
    }
    rows.forEach((row, rowIndex) => {
      if (!isObject(row)) {
        throw new ArtifactRecoveryCorruptionError(
          `Invalid coder turn ${collection}[${rowIndex}] in ${source}`,
        );
      }
      if (row.artifact_refs !== undefined) {
        collectArtifactRefArray(
          row.artifact_refs,
          `${source}.payload.${collection}[${rowIndex}].artifact_refs`,
          references,
        );
      }
      if (!Array.isArray(row.content)) return;
      row.content.forEach((block, blockIndex) => {
        if (!isObject(block)) return;
        if (block.type === 'artifact_ref') {
          collectRequiredArtifactRef(
            block.artifact,
            `${source}.payload.${collection}[${rowIndex}].content[${blockIndex}].artifact`,
            references,
          );
        } else if (block.type === 'tool_result_ref') {
          referencedToolCallIds.add(
            collectToolOutputRefs(
              block.output,
              `${source}.payload.${collection}[${rowIndex}].content[${blockIndex}].output`,
              references,
            ),
          );
        }
      });
    });
  }

  if (!Array.isArray(payload.tool_calls)) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid coder turn tool_calls in ${source}`,
    );
  }
  payload.tool_calls.forEach((call, index) => {
    if (!isObject(call)) {
      throw new ArtifactRecoveryCorruptionError(
        `Invalid coder turn tool_calls[${index}] in ${source}`,
      );
    }
    referencedToolCallIds.add(
      collectToolOutputRefs(
        call.output,
        `${source}.payload.tool_calls[${index}].output`,
        references,
      ),
    );
  });
}

function requireObject(value: unknown, source: string): Record<string, unknown> {
  if (!isObject(value)) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid schema-owned artifact metadata in ${source}`,
    );
  }
  return value;
}

function collectNullableArtifactRef(
  owner: Record<string, unknown>,
  field: string,
  source: string,
  references: Map<string, ReferencedArtifact>,
): void {
  const value = owner[field];
  if (value === null) return;
  if (value === undefined) {
    throw new ArtifactRecoveryCorruptionError(
      `Missing schema-owned artifact field ${source}.${field}`,
    );
  }
  collectRequiredArtifactRef(value, `${source}.${field}`, references);
}

function isEntityRecordAt(
  value: unknown,
  source: string,
): {
  readonly record: Record<string, unknown>;
  readonly data: Record<string, unknown>;
} {
  const record = requireObject(value, source);
  const data = requireObject(record.data, `${source}.data`);
  return { record, data };
}

function collectApplicationMetadataRefs(
  value: unknown,
  source: string,
  relativePath: string,
  references: Map<string, ReferencedArtifact>,
  pendingToolOutputs: PendingToolOutputMetadata[],
): void {
  if (/^tools_outputs\/calls\/[^/]+\.json$/.test(relativePath)) {
    const record = requireObject(value, source);
    const toolReferences = new Map<string, ReferencedArtifact>();
    const callId = collectToolOutputRefs(record, source, toolReferences);
    if (basename(relativePath) !== toolOutputRecordFileName(callId)) {
      throw new ArtifactRecoveryCorruptionError(
        `Tool output call_id/file-name mismatch in ${source}`,
      );
    }
    const metadata = requireObject(record.metadata, `${source}.metadata`);
    const outputId = metadata.output_id;
    const standalone =
      metadata.purpose === 'truncated_tool_output' &&
      typeof outputId === 'string' &&
      /^[0-9a-f]{24}$/.test(outputId) &&
      callId === `spill:${outputId}`;
    pendingToolOutputs.push({
      path: source,
      call_id: callId,
      references: toolReferences,
      standalone,
    });
    return;
  }
  if (/^tools_outputs\/legacy_spills\/[^/]+\.json$/.test(relativePath)) {
    const spill = requireObject(value, source);
    collectNullableArtifactRef(spill, 'raw', source, references);
    return;
  }
  if (relativePath === 'subagents/transcripts.json') {
    const index = requireObject(value, source);
    if (!Array.isArray(index.records)) {
      throw new ArtifactRecoveryCorruptionError(
        `Invalid subagent transcript index in ${source}`,
      );
    }
    index.records.forEach((record, recordIndex) => {
      const entry = requireObject(
        record,
        `${source}.records[${recordIndex}]`,
      );
      collectNullableArtifactRef(
        entry,
        'artifact',
        `${source}.records[${recordIndex}]`,
        references,
      );
    });
    return;
  }
  if (relativePath === 'session.json') {
    const session = requireObject(value, source);
    if (session.kind !== 'design') return;
    const metadata = requireObject(session.metadata, `${source}.metadata`);
    const design = requireObject(metadata.design, `${source}.metadata.design`);
    collectNullableArtifactRef(
      design,
      'sourceZipRef',
      `${source}.metadata.design`,
      references,
    );
    return;
  }

  if (/^snapshots\/[^/]+\.json$/.test(relativePath)) {
    const { record, data } = isEntityRecordAt(value, source);
    if (record.kind === 'file_baseline') {
      collectNullableArtifactRef(data, 'content_before', `${source}.data`, references);
      collectNullableArtifactRef(data, 'rollback_content', `${source}.data`, references);
    } else if (record.kind === 'round_snapshot') {
      collectNullableArtifactRef(data, 'content_before', `${source}.data`, references);
      collectNullableArtifactRef(data, 'content_after', `${source}.data`, references);
    } else if (record.kind === 'review_run') {
      collectNullableArtifactRef(data, 'raw_response', `${source}.data`, references);
    }
    return;
  }

  if (
    /^snapshots\/session_file_baselines\/[^/]+\.json$/.test(relativePath)
  ) {
    const { data } = isEntityRecordAt(value, source);
    collectNullableArtifactRef(data, 'content_before', `${source}.data`, references);
    collectNullableArtifactRef(data, 'rollback_content', `${source}.data`, references);
    collectMigratedEntityArtifactList(data, source, references);
    return;
  }
  if (
    /^snapshots\/session_file_round_snapshots\/[^/]+\.json$/.test(relativePath)
  ) {
    const { data } = isEntityRecordAt(value, source);
    collectNullableArtifactRef(data, 'content_before', `${source}.data`, references);
    collectNullableArtifactRef(data, 'content_after', `${source}.data`, references);
    collectMigratedEntityArtifactList(data, source, references);
    return;
  }

  if (/^checkpoints\/builder\/[^/]+\.json$/.test(relativePath)) {
    const { record, data } = isEntityRecordAt(value, source);
    if (record.kind === 'builder_checkpoint') {
      collectNullableArtifactRef(data, 'screenshot', `${source}.data`, references);
    }
    return;
  }
  if (/^design\/versions\/[^/]+\.json$/.test(relativePath)) {
    const { record, data } = isEntityRecordAt(value, source);
    if (record.kind === 'design.version') {
      collectNullableArtifactRef(data, 'tarballRef', `${source}.data`, references);
    }
    return;
  }
  if (/^company\/drive-files\/[^/]+\.json$/.test(relativePath)) {
    const { data } = isEntityRecordAt(value, source);
    const file = data.file;
    if (file !== undefined && file !== null) {
      if (isObject(file) && file.type === 'legacy_artifact_unavailable') {
        // The migration explicitly records a missing legacy payload.
      } else {
        collectRequiredArtifactRef(file, `${source}.data.file`, references);
      }
    }
    collectMigratedEntityArtifactList(data, source, references);
    return;
  }

  // The migrator records every recursively externalized inline payload in a
  // schema-owned, flat ArtifactRef list. Inspect that list only on migrated
  // entity envelopes; never walk arbitrary entity data, state.extra, tool
  // arguments, Sprite settings, or user JSON.
  if (
    isObject(value) &&
    isObject(value.data) &&
    typeof value.data._legacy_table === 'string'
  ) {
    collectMigratedEntityArtifactList(value.data, source, references);
  }
}

function collectMigratedEntityArtifactList(
  data: Record<string, unknown>,
  source: string,
  references: Map<string, ReferencedArtifact>,
): void {
  if (data.artifacts === undefined) return;
  collectArtifactRefArray(data.artifacts, `${source}.data.artifacts`, references);
}

function mergeReferences(
  target: Map<string, ReferencedArtifact>,
  incoming: ReadonlyMap<string, ReferencedArtifact>,
): void {
  for (const { ref, source } of incoming.values()) {
    collectRequiredArtifactRef(ref, source, target);
  }
}

function decodeUtf8(bytes: Uint8Array, source: string): string {
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid UTF-8 metadata ${source}: ${(error as Error).message}`,
    );
  }
}

function parseMetadata(
  bytes: Uint8Array,
  source: string,
): readonly unknown[] {
  const text = decodeUtf8(bytes, source);
  if (source.endsWith('.jsonl')) {
    if (text.length === 0) return [];
    if (!text.endsWith('\n')) {
      throw new ArtifactRecoveryCorruptionError(
        `Uncommitted JSONL fragment in ${source}`,
      );
    }
    return text
      .split('\n')
      .slice(0, -1)
      .map((line, index) => {
        if (line.length === 0) {
          throw new ArtifactRecoveryCorruptionError(
            `Blank JSONL record in ${source}:${index + 1}`,
          );
        }
        try {
          return JSON.parse(line) as unknown;
        } catch (error) {
          throw new ArtifactRecoveryCorruptionError(
            `Invalid JSONL metadata ${source}:${index + 1}: ${(error as Error).message}`,
          );
        }
      });
  }
  try {
    return [JSON.parse(text) as unknown];
  } catch (error) {
    throw new ArtifactRecoveryCorruptionError(
      `Invalid JSON metadata ${source}: ${(error as Error).message}`,
    );
  }
}

async function metadataFiles(bundlePath: string): Promise<string[]> {
  const blobRoots = new Set(
    Object.values(SESSION_ARTIFACT_ROOTS).map((segments) =>
      pathKey(join(bundlePath, ...segments)),
    ),
  );
  const output: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    await assertPathHasNoLinks(bundlePath, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      assertContainedPath(bundlePath, child);
      const stats = await lstat(child);
      if (stats.isSymbolicLink()) {
        throw new UnsafeSessionPathError(
          `Symbolic link in session metadata tree: ${child}`,
        );
      }
      if (stats.isDirectory()) {
        if (!blobRoots.has(pathKey(child))) await visit(child);
        continue;
      }
      if (!stats.isFile()) {
        throw new UnsafeSessionPathError(
          `Non-regular file in session bundle: ${child}`,
        );
      }
      if (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl')) {
        output.push(child);
      }
    }
  };

  await visit(bundlePath);
  return output.sort();
}

async function readMetadataFile(path: string): Promise<Uint8Array> {
  const stats = await lstat(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new UnsafeSessionPathError(
      `Session metadata is not a regular file: ${path}`,
    );
  }
  return readFile(path);
}

function sameOpenedFile(
  expected: Awaited<ReturnType<typeof lstat>>,
  actual: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return (
    expected.isFile() &&
    actual.isFile() &&
    expected.dev === actual.dev &&
    expected.ino === actual.ino
  );
}

async function hashBlob(path: string): Promise<{
  readonly sha256: string;
  readonly size: number;
  readonly identity: Awaited<ReturnType<typeof lstat>>;
}> {
  const identity = await lstat(path);
  if (identity.isSymbolicLink() || !identity.isFile()) {
    throw new UnsafeSessionPathError(
      `Artifact blob is not a regular file: ${path}`,
    );
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (!sameOpenedFile(identity, opened)) {
      throw new UnsafeSessionPathError(
        `Artifact blob changed while opening: ${path}`,
      );
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return {
      sha256: digest.digest('hex'),
      size: position,
      identity,
    };
  } finally {
    await handle.close();
  }
}

function sameIdentity(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export async function recoverSessionArtifacts(options: {
  readonly bundlePath: string;
  readonly sessionId: SessionId;
  readonly faultInjector?: SessionStorageFaultInjector;
}): Promise<ArtifactRecoveryResult> {
  const bundlePath = resolve(options.bundlePath);
  await options.faultInjector?.({
    point: 'artifact-recovery:before-scan',
    session_id: options.sessionId,
    path: bundlePath,
  });

  const files = await metadataFiles(bundlePath);
  const references = new Map<string, ReferencedArtifact>();
  const referencedToolCallIds = new Set<string>();
  const pendingToolOutputs: PendingToolOutputMetadata[] = [];
  for (const file of files) {
    const values = parseMetadata(await readMetadataFile(file), file);
    const relativeMetadataPath = posixRelative(bundlePath, file);
    for (let index = 0; index < values.length; index += 1) {
      const source = `${file}${file.endsWith('.jsonl') ? `:${index + 1}` : ''}`;
      if (basename(file) === 'conversation.jsonl') {
        collectConversationRefs(
          values[index],
          source,
          references,
          referencedToolCallIds,
        );
      } else {
        collectApplicationMetadataRefs(
          values[index],
          source,
          relativeMetadataPath,
          references,
          pendingToolOutputs,
        );
      }
    }
  }

  const toolRecordsByCallId = new Map<string, PendingToolOutputMetadata>();
  const orphanToolRecordPaths: string[] = [];
  for (const record of pendingToolOutputs) {
    if (toolRecordsByCallId.has(record.call_id)) {
      throw new ArtifactRecoveryCorruptionError(
        `Duplicate tool output metadata for call_id ${record.call_id}`,
      );
    }
    toolRecordsByCallId.set(record.call_id, record);
    if (record.standalone || referencedToolCallIds.has(record.call_id)) {
      mergeReferences(references, record.references);
    } else {
      orphanToolRecordPaths.push(record.path);
    }
  }
  for (const callId of referencedToolCallIds) {
    if (!toolRecordsByCallId.has(callId)) {
      throw new ArtifactRecoveryCorruptionError(
        `Conversation references missing tool output metadata for call_id ${callId}`,
      );
    }
  }

  let scannedBlobs = 0;
  let removedToolRecords = 0;
  let removedBlobs = 0;
  const foundReferences = new Set<string>();
  const orphanBlobs: Array<{
    readonly path: string;
    readonly shard_path: string;
    readonly identity: Awaited<ReturnType<typeof lstat>>;
  }> = [];
  for (const segments of Object.values(SESSION_ARTIFACT_ROOTS)) {
    const root = join(bundlePath, ...segments);
    let shards;
    try {
      const rootStat = await lstat(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new UnsafeSessionPathError(
          `Artifact root is not a safe directory: ${root}`,
        );
      }
      shards = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }

    for (const shard of shards) {
      const shardPath = join(root, shard.name);
      if (!SHARD.test(shard.name)) {
        throw new ArtifactRecoveryCorruptionError(
          `Invalid artifact shard ${shardPath}`,
        );
      }
      const shardStat = await lstat(shardPath);
      if (shardStat.isSymbolicLink() || !shardStat.isDirectory()) {
        throw new UnsafeSessionPathError(
          `Artifact shard is not a safe directory: ${shardPath}`,
        );
      }
      for (const entry of await readdir(shardPath, { withFileTypes: true })) {
        const blobPath = join(shardPath, entry.name);
        if (!SHA256.test(entry.name) || entry.name.slice(0, 2) !== shard.name) {
          throw new ArtifactRecoveryCorruptionError(
            `Invalid content-addressed artifact name ${blobPath}`,
          );
        }
        const relativePath = posixRelative(bundlePath, blobPath);
        const hashed = await hashBlob(blobPath);
        scannedBlobs += 1;
        if (hashed.sha256 !== entry.name) {
          throw new ArtifactRecoveryCorruptionError(
            `Artifact content hash mismatch at ${blobPath}`,
          );
        }
        const referenced = references.get(relativePath);
        if (referenced) {
          if (referenced.ref.size !== hashed.size) {
            throw new ArtifactRecoveryCorruptionError(
              `Artifact size mismatch for ${relativePath} referenced by ${referenced.source}`,
            );
          }
          foundReferences.add(relativePath);
          continue;
        }
        orphanBlobs.push({
          path: blobPath,
          shard_path: shardPath,
          identity: hashed.identity,
        });
      }
    }
  }

  for (const [relativePath, reference] of references) {
    if (!foundReferences.has(relativePath)) {
      throw new ArtifactRecoveryCorruptionError(
        `Referenced artifact ${relativePath} from ${reference.source} is missing`,
      );
    }
  }

  // Remove unreachable tool-call metadata before its blobs. A crash between
  // these phases leaves harmless unreferenced blobs for the next recovery,
  // never a published record that points at a deleted payload.
  for (const recordPath of orphanToolRecordPaths) {
    await assertPathHasNoLinks(bundlePath, recordPath);
    const current = await lstat(recordPath);
    if (current.isSymbolicLink() || !current.isFile()) {
      throw new UnsafeSessionPathError(
        `Tool output metadata changed before garbage collection: ${recordPath}`,
      );
    }
    await options.faultInjector?.({
      point: 'artifact-recovery:before-remove-tool-record',
      session_id: options.sessionId,
      path: recordPath,
    });
    await unlink(recordPath);
    await fsyncDirectory(dirname(recordPath));
    removedToolRecords += 1;
    await options.faultInjector?.({
      point: 'artifact-recovery:after-remove-tool-record',
      session_id: options.sessionId,
      path: recordPath,
    });
  }

  // Deletion is deliberately a second phase. Invalid metadata, a missing
  // referenced blob, an invalid shard, or a hash mismatch therefore aborts
  // without deleting any candidate.
  for (const orphan of orphanBlobs) {
    await assertPathHasNoLinks(bundlePath, orphan.path);
    const current = await lstat(orphan.path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameIdentity(orphan.identity, current)
    ) {
      throw new UnsafeSessionPathError(
        `Artifact changed before garbage collection: ${orphan.path}`,
      );
    }
    await options.faultInjector?.({
      point: 'artifact-recovery:before-remove',
      session_id: options.sessionId,
      path: orphan.path,
    });
    await unlink(orphan.path);
    await fsyncDirectory(orphan.shard_path);
    removedBlobs += 1;
    await options.faultInjector?.({
      point: 'artifact-recovery:after-remove',
      session_id: options.sessionId,
      path: orphan.path,
    });
  }

  await options.faultInjector?.({
    point: 'artifact-recovery:after-scan',
    session_id: options.sessionId,
    path: bundlePath,
  });
  return {
    metadata_files: files.length,
    referenced_blobs: references.size,
    scanned_blobs: scannedBlobs,
    removed_tool_records: removedToolRecords,
    removed_blobs: removedBlobs,
  };
}
