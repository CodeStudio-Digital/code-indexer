import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  atomicWriteFile,
  atomicWriteJson,
  canonicalJson,
} from './atomic-file.js';
import {
  assertContainedPath,
  assertPathHasNoLinksSync,
  ensureDirectoryTreeNoLinks,
  UnsafeSessionPathError,
} from './path-safety.js';
import type {
  ArtifactInput,
  ArtifactKind,
  ArtifactRef,
  JsonValue,
  SessionId,
  SessionStorageFaultInjector,
  ToolOutputInput,
  ToolOutputRecord,
} from './types.js';
import { isUuid } from './types.js';

export const SESSION_ARTIFACT_ROOTS: Readonly<
  Record<ArtifactKind, readonly string[]>
> = {
  attachment: ['attachments', 'blobs', 'sha256'],
  tool_output_raw: ['tools_outputs', 'blobs', 'raw', 'sha256'],
  tool_output_shaped: ['tools_outputs', 'blobs', 'shaped', 'sha256'],
  snapshot_blob: ['snapshots', 'blobs', 'sha256'],
};

function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function assertToolCallId(callId: string): void {
  if (
    typeof callId !== 'string' ||
    callId.length === 0 ||
    callId.length > 4096 ||
    callId.includes('\0')
  ) {
    throw new TypeError('tool call id must be a non-empty opaque string');
  }
}

/**
 * Tool call IDs are protocol values, not filenames. Hashing keeps Windows
 * reserved names and punctuation out of the filesystem namespace while the
 * metadata record preserves the original ID.
 */
export function toolOutputRecordFileName(callId: string): string {
  assertToolCallId(callId);
  return `${sha256(Buffer.from(callId, 'utf8'))}.json`;
}

export class ToolOutputConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolOutputConflictError';
  }
}

function toolOutputSignature(value: {
  readonly call_id: string;
  readonly raw: ArtifactRef | null;
  readonly shaped: ArtifactRef | null;
  readonly metadata: Readonly<Record<string, JsonValue>>;
}): string {
  return canonicalJson({
    call_id: value.call_id,
    raw: value.raw,
    shaped: value.shaped,
    metadata: value.metadata,
  });
}

function posixRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/');
}

export interface ArtifactStoreOptions {
  readonly bundlePath: string;
  readonly sessionId: SessionId;
  readonly faultInjector?: SessionStorageFaultInjector;
}

export interface ArtifactReader {
  read(ref: ArtifactRef): Uint8Array;
}

export class ArtifactStore implements ArtifactReader {
  readonly #bundlePath: string;
  readonly #sessionId: SessionId;
  readonly #faultInjector?: SessionStorageFaultInjector;

  constructor(options: ArtifactStoreOptions) {
    this.#bundlePath = options.bundlePath;
    this.#sessionId = options.sessionId;
    this.#faultInjector = options.faultInjector;
  }

  describe(input: ArtifactInput): ArtifactRef {
    const bytes = toBytes(input.data);
    const digest = sha256(bytes);
    const base = join(this.#bundlePath, ...SESSION_ARTIFACT_ROOTS[input.kind]);
    const artifactPath = join(base, digest.slice(0, 2), digest);
    assertContainedPath(this.#bundlePath, artifactPath);
    return {
      artifact_id: `sha256:${digest}`,
      kind: input.kind,
      sha256: digest,
      size: bytes.byteLength,
      relative_path: posixRelative(this.#bundlePath, artifactPath),
      media_type: input.media_type ?? null,
      logical_name: input.logical_name ?? null,
    };
  }

  async put(input: ArtifactInput): Promise<ArtifactRef> {
    const bytes = toBytes(input.data);
    const ref = this.describe(input);
    const artifactPath = join(this.#bundlePath, ...ref.relative_path.split('/'));
    const artifactDirectory = dirname(artifactPath);
    await ensureDirectoryTreeNoLinks(this.#bundlePath, artifactDirectory);
    await this.#faultInjector?.({
      point: 'artifact:before-write',
      session_id: this.#sessionId,
      path: artifactPath,
    });

    try {
      const existing = await lstat(artifactPath);
      if (existing.isSymbolicLink()) {
        throw new UnsafeSessionPathError(`Artifact cannot be a symbolic link: ${artifactPath}`);
      }
      if (!existing.isFile() || existing.size !== ref.size) {
        throw new Error(`Artifact hash collision or invalid artifact at ${artifactPath}`);
      }
      const existingBytes = await readFile(artifactPath);
      if (sha256(existingBytes) !== ref.sha256) {
        throw new Error(`Artifact hash mismatch at ${artifactPath}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
      try {
        await atomicWriteFile(artifactPath, bytes, {
          faultInjector: this.#faultInjector,
          context: { session_id: this.#sessionId },
        });
      } catch (writeError) {
        if ((writeError as NodeJS.ErrnoException)?.code !== 'EEXIST') throw writeError;
        const existingBytes = await readFile(artifactPath);
        if (sha256(existingBytes) !== ref.sha256) throw writeError;
      }
    }

    await this.#faultInjector?.({
      point: 'artifact:after-write',
      session_id: this.#sessionId,
      path: artifactPath,
    });
    return ref;
  }

  read(ref: ArtifactRef): Uint8Array {
    const artifactPath = join(this.#bundlePath, ...ref.relative_path.split('/'));
    assertContainedPath(this.#bundlePath, artifactPath);
    assertPathHasNoLinksSync(this.#bundlePath, artifactPath);
    const bytes = readFileSync(artifactPath);
    if (bytes.byteLength !== ref.size || sha256(bytes) !== ref.sha256) {
      throw new Error(`Artifact verification failed: ${ref.relative_path}`);
    }
    return bytes;
  }

  async putToolOutput(input: ToolOutputInput): Promise<ToolOutputRecord> {
    const recordFileName = toolOutputRecordFileName(input.call_id);
    const rawInput =
      input.raw === undefined
        ? null
        : {
            kind: 'tool_output_raw',
            data: input.raw,
            media_type: input.raw_media_type ?? input.media_type,
            logical_name: `${input.call_id}.raw`,
          } as const;
    const shapedInput =
      input.shaped === undefined
        ? null
        : {
            kind: 'tool_output_shaped',
            data: input.shaped,
            media_type: input.shaped_media_type ?? input.media_type,
            logical_name: `${input.call_id}.shaped`,
          } as const;
    const described = {
      call_id: input.call_id,
      raw: rawInput ? this.describe(rawInput) : null,
      shaped: shapedInput ? this.describe(shapedInput) : null,
      metadata: input.metadata ?? {},
    };
    const callsDirectory = join(this.#bundlePath, 'tools_outputs', 'calls');
    await ensureDirectoryTreeNoLinks(this.#bundlePath, callsDirectory);
    const recordPath = join(callsDirectory, recordFileName);

    let existing: ToolOutputRecord | null = null;
    try {
      const existingStat = await lstat(recordPath);
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
        throw new UnsafeSessionPathError(
          `Tool output record is not a safe file: ${recordPath}`,
        );
      }
      existing = JSON.parse(await readFile(recordPath, 'utf8')) as ToolOutputRecord;
      if (
        existing.schema_version !== 1 ||
        !isUuid(existing.id) ||
        existing.call_id !== input.call_id ||
        typeof existing.created_at !== 'string'
      ) {
        throw new Error(`Invalid tool output record: ${recordPath}`);
      }
      if (toolOutputSignature(existing) !== toolOutputSignature(described)) {
        throw new ToolOutputConflictError(
          `tool call ${input.call_id} was already persisted with different output`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }

    // Blobs become durable before either publishing a new metadata record or
    // returning an idempotent replay. Re-putting an existing hash also repairs
    // a missing blob without changing the stable tool-output identity.
    const raw = rawInput ? await this.put(rawInput) : null;
    const shaped = shapedInput ? await this.put(shapedInput) : null;
    if (existing) return existing;

    const record: ToolOutputRecord = {
      schema_version: 1,
      id: randomUUID(),
      call_id: input.call_id,
      created_at: new Date().toISOString(),
      raw,
      shaped,
      metadata: input.metadata ?? {},
    };
    await atomicWriteJson(recordPath, record, {
      faultInjector: this.#faultInjector,
      context: { session_id: this.#sessionId },
    });
    return record;
  }
}
