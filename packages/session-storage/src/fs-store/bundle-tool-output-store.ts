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

  put(content: string): string | null {
    if (typeof content !== 'string') return null;
    const id = outputId(content);
    this.#memory.set(id, content);
    if (!this.#pending.has(id)) {
      const write = this.#store.repository
        .writeToolOutput(this.#requireLocation(), {
          call_id: callId(id),
          raw: content,
          raw_media_type: 'text/plain; charset=utf-8',
          metadata: {
            purpose: 'truncated_tool_output',
            output_id: id,
          },
        })
        .then(() => undefined)
        .catch((error: unknown) => {
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

  get(id: string): string | null {
    const normalized = id.trim().toLowerCase();
    if (!/^[a-f0-9]{6,64}$/.test(normalized)) return null;
    const cached = this.#memory.get(normalized);
    if (cached !== undefined) return cached;

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
      const artifacts = new ArtifactStore({
        bundlePath: this.#bundlePath,
        sessionId: this.#sessionId,
      });
      const content = Buffer.from(artifacts.read(record.raw)).toString('utf8');
      this.#memory.set(normalized, content);
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  hasOutputs(): boolean {
    if (this.#memory.size > 0) return true;
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
