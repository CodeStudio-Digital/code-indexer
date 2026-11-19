import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactStore,
  assertPathHasNoLinksSync,
  toolOutputRecordFileName,
  type SessionId,
  type ToolOutputRecord,
} from '@mcp/session-storage';
import type { FsSessionStore } from './fs-session-store.js';

interface StoredImage { name?: string; mediaType: string; base64: string }
interface ImageReference { id: string; name: string; mediaType: string }

function outputId(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 24);
}

function callId(id: string): string {
  return `spill:${id}`;
}

/**
 * Synchronous hot-cache facade required by tool execution, backed durably by
 * the owning session bundle. No TTL or global side directory exists: payloads
 * live until the session itself is trashed/purged.
 */
export class BundleToolOutputStore {
  readonly #sessionId: SessionId;
  readonly #bundlePath: string;
  readonly #store: FsSessionStore;
  readonly #memory = new Map<string, string>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #images = new Map<string, ImageReference>();
  #imageCatalogLoaded = false;
  #failure: Error | null = null;

  constructor(store: FsSessionStore, sessionId: SessionId) {
    const entry = store.catalog.get(sessionId);
    if (!entry) {
      throw new Error(`Filesystem session ${sessionId} is not loaded`);
    }
    this.#store = store;
    this.#sessionId = sessionId;
    this.#bundlePath = entry.location.bundle_path;
  }

  put(content: string, image?: Omit<ImageReference, 'id'>): string | null {
    if (typeof content !== 'string') return null;
    const id = outputId(content);
    if (image) this.#images.set(id, { id, ...image });
    if (this.#memory.has(id)) return id;
    this.#memory.set(id, content);
    if (!this.#pending.has(id)) {
      const write = this.#store.repository
        .writeToolOutput(this.#requireLocation(), {
          call_id: callId(id),
          raw: content,
          raw_media_type: 'text/plain; charset=utf-8',
          metadata: {
            purpose: image ? 'session_image' : 'truncated_tool_output',
            output_id: id,
            ...(image ? { image } : {}),
          },
        })
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#memory.delete(id);
          this.#images.delete(id);
          this.#failure =
            error instanceof Error ? error : new Error(String(error));
          throw this.#failure;
        })
        .finally(() => {
          this.#pending.delete(id);
        });
      this.#pending.set(id, write);
      void write.catch(() => undefined);
    }
    return id;
  }

  putImage(image: StoredImage): string | null {
    const { mediaType, base64 } = image;
    return this.put(JSON.stringify({ mediaType, base64 }), {
      name: image.name || 'image', mediaType,
    });
  }

  async saveImage(image: StoredImage): Promise<string | null> {
    const id = this.putImage(image);
    if (id) await this.#pending.get(id);
    return id;
  }

  /** Catalog metadata survives compaction/restart without loading any pixels. */
  listImages(): ImageReference[] {
    const directory = join(this.#bundlePath, 'tools_outputs', 'calls');
    if (!this.#imageCatalogLoaded && existsSync(directory)) {
      assertPathHasNoLinksSync(this.#bundlePath, directory);
      for (const name of readdirSync(directory)) {
        if (!name.endsWith('.json')) continue;
        const path = join(directory, name);
        assertPathHasNoLinksSync(this.#bundlePath, path);
        const record = JSON.parse(readFileSync(path, 'utf8')) as ToolOutputRecord;
        const metadata = record.metadata;
        if (metadata.purpose !== 'session_image' || typeof metadata.output_id !== 'string') continue;
        const image = metadata.image as Omit<ImageReference, 'id'> | undefined;
        if (image && typeof image.name === 'string' && typeof image.mediaType === 'string') {
          this.#images.set(metadata.output_id, { id: metadata.output_id, ...image });
        }
      }
    }
    this.#imageCatalogLoaded = true;
    return [...this.#images.values()];
  }

  get(id: string): string | null {
    const normalized = id.trim().toLowerCase();
    if (!/^[a-f0-9]{6,64}$/.test(normalized)) return null;
    const cached = this.#memory.get(normalized);
    if (cached !== undefined) return cached;
    const record = this.#readRecord(normalized);
    return record ? this.#readPayload(normalized, record) : null;
  }

  getImage(id: string): (ImageReference & { base64: string }) | null {
    const normalized = id.trim().toLowerCase();
    if (!/^[a-f0-9]{6,64}$/.test(normalized)) return null;
    let reference = this.#images.get(normalized);
    let content = this.#memory.get(normalized) ?? null;
    if (!reference || content === null) {
      const record = this.#readRecord(normalized);
      if (!record || record.metadata.purpose !== 'session_image') return null;
      const image = record.metadata.image as Omit<ImageReference, 'id'> | undefined;
      if (!image || typeof image.name !== 'string' || typeof image.mediaType !== 'string') return null;
      reference = { id: normalized, ...image };
      this.#images.set(normalized, reference);
      content ??= this.#readPayload(normalized, record);
    }
    if (content === null) return null;
    const payload = JSON.parse(content) as StoredImage;
    return typeof payload.base64 === 'string' ? { ...reference, base64: payload.base64 } : null;
  }

  #readRecord(normalized: string): ToolOutputRecord | null {
    const recordPath = join(
      this.#bundlePath,
      'tools_outputs',
      'calls',
      toolOutputRecordFileName(callId(normalized)),
    );
    try {
      assertPathHasNoLinksSync(this.#bundlePath, recordPath);
      const record = JSON.parse(
        readFileSync(recordPath, 'utf8'),
      ) as ToolOutputRecord;
      if (
        record.schema_version !== 1 ||
        record.call_id !== callId(normalized) ||
        record.metadata.output_id !== normalized ||
        !record.raw
      ) {
        throw new Error(`Invalid bundled tool output record ${recordPath}`);
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  #readPayload(id: string, record: ToolOutputRecord): string | null {
    const artifacts = new ArtifactStore({ bundlePath: this.#bundlePath, sessionId: this.#sessionId });
    try {
      const content = Buffer.from(artifacts.read(record.raw!)).toString('utf8');
      this.#memory.set(id, content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  hasOutputs(): boolean {
    if ([...this.#memory.keys()].some(id => !this.#images.has(id))) return true;
    const callsDirectory = join(
      this.#bundlePath,
      'tools_outputs',
      'calls',
    );
    if (!existsSync(callsDirectory)) return false;
    assertPathHasNoLinksSync(this.#bundlePath, callsDirectory);
    for (const name of readdirSync(callsDirectory)) {
      if (!name.endsWith('.json')) continue;
      const path = join(callsDirectory, name);
      assertPathHasNoLinksSync(this.#bundlePath, path);
      const record = JSON.parse(readFileSync(path, 'utf8')) as ToolOutputRecord;
      if (record.metadata.purpose === 'truncated_tool_output') return true;
    }
    return false;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending.values()]);
    if (this.#failure) throw this.#failure;
  }

  #requireLocation() {
    const entry = this.#store.catalog.get(this.#sessionId);
    if (!entry || entry.location.bundle_path !== this.#bundlePath) {
      throw new Error(`Filesystem session ${this.#sessionId} moved while active`);
    }
    return entry.location;
  }
}
