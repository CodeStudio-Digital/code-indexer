import type { ArtifactRef, JsonValue, SessionId } from '@mcp/session-storage';
import type { SessionKind, ToolSnapshotMutation, ToolSnapshotRow } from '../contracts/session-snapshot-port.js';
import { FsSessionEntityFiles, type FsEntityEnvelope } from './entity-files.js';
import { FsSessionDirectory } from './session-directory.js';
import { validateSnapshotFilePath } from './snapshot-files-codec.js';

type Row = ToolSnapshotRow<SessionId, string>;
type StoredFile = Omit<Row, 'content_before' | 'content_after'> & {
  content_before: ArtifactRef | null; content_after: ArtifactRef | null;
};
interface StoredCall { tool_use_id: string; files: StoredFile[] }

/** One durable envelope per tool invocation; later calls never update an earlier one. */
export class FsToolSnapshotRepository {
  readonly #recordIds = new Map<string, string>();
  readonly #scans = new Map<SessionId, Promise<FsEntityEnvelope<JsonValue>[]>>();
  constructor(private readonly directory: FsSessionDirectory, private readonly entities: FsSessionEntityFiles) {}

  async #find(sessionId: SessionId, toolUseId: string): Promise<FsEntityEnvelope<JsonValue> | undefined> {
    const key = `${sessionId}:${toolUseId}`;
    const id = this.#recordIds.get(key);
    if (id) {
      const cached = await this.entities.get<JsonValue>(sessionId, 'snapshots', id);
      if (cached?.kind === 'tool_snapshot' && cached.deleted_at == null) return cached;
      this.#recordIds.delete(key);
    }
    // A restored transcript can request many cards at once. Share its metadata
    // scan and cache only UUIDs; contents remain on disk and edits remain fresh.
    let pending = this.#scans.get(sessionId);
    if (!pending) {
      pending = this.entities.list<JsonValue>(sessionId, 'snapshots', 'tool_snapshot');
      this.#scans.set(sessionId, pending);
    }
    try {
      const rows = await pending;
      for (const row of rows) {
        this.#recordIds.set(`${sessionId}:${(row.data as unknown as StoredCall).tool_use_id}`, row.id);
      }
      while (this.#recordIds.size > 2048) this.#recordIds.delete(this.#recordIds.keys().next().value!);
      return rows.find(row => (row.data as unknown as StoredCall).tool_use_id === toolUseId);
    } finally { if (this.#scans.get(sessionId) === pending) this.#scans.delete(sessionId); }
  }

  async recordToolSnapshotMutation(input: ToolSnapshotMutation<SessionId, string>): Promise<void> {
    validateSnapshotFilePath(input.file_path);
    if (!input.tool_use_id || input.tool_use_id.length > 512) throw new Error('Invalid snapshot tool-use id');
    await this.directory.runMutation(input.session_id, async () => {
      const entry = await this.directory.requireEntry(input.session_id);
      const artifacts = await this.directory.repository.artifactStore(entry.location);
      const put = async (text: string | null, suffix: string) => input.oversized || text == null ? null : artifacts.put({
        kind: 'snapshot_blob', data: text, media_type: 'text/plain; charset=utf-8', logical_name: `${input.file_path}:${suffix}`,
      });
      const before = await put(input.content_before, 'before');
      const after = await put(input.content_after, 'after');
      const records = await this.entities.list<JsonValue>(input.session_id, 'snapshots', 'tool_snapshot');
      const existing = records.find(record => (record.data as unknown as StoredCall).tool_use_id === input.tool_use_id);
      const now = new Date().toISOString();
      const file: StoredFile = { ...input, project_id: input.project_id ?? null, content_before: before, content_after: after,
        first_seen_at: now, last_edited_at: now };
      const options = { operation_id: input.operation_id, operation_key: input };
      if (!existing) {
        const created = await this.entities.createWithinMutation(input.session_id, 'snapshots', {
          kind: 'tool_snapshot', data: { tool_use_id: input.tool_use_id, files: [file] }, ...options,
        });
        this.#recordIds.set(`${input.session_id}:${input.tool_use_id}`, created.id);
      } else {
        await this.entities.updateWithinMutation<StoredCall>(input.session_id, 'snapshots', existing.id, current => {
          const index = current.files.findIndex(item => item.project_id === file.project_id && item.file_path === file.file_path);
          const files = [...current.files];
          if (index < 0) files.push(file);
          else files[index] = { ...file, content_before: files[index]!.content_before, existed_before: files[index]!.existed_before,
            first_seen_at: files[index]!.first_seen_at, oversized: files[index]!.oversized || file.oversized };
          return { ...current, files };
        }, options);
        this.#recordIds.set(`${input.session_id}:${input.tool_use_id}`, existing.id);
      }
      this.#scans.delete(input.session_id);
      while (this.#recordIds.size > 2048) this.#recordIds.delete(this.#recordIds.keys().next().value!);
    });
  }

  async listToolSnapshots(kind: SessionKind, sessionId: SessionId, toolUseId: string): Promise<Row[]> {
    const record = await this.#find(sessionId, toolUseId);
    if (!record) return [];
    const data = record.data as unknown as StoredCall;
    const entry = await this.directory.requireEntry(sessionId);
    const artifacts = this.directory.repository.artifactReader(entry.location);
    return data.files.filter(file => file.session_kind === kind && file.session_id === sessionId).map(file => ({
      ...file,
      content_before: file.content_before ? Buffer.from(artifacts.read(file.content_before)).toString('utf8') : null,
      content_after: file.content_after ? Buffer.from(artifacts.read(file.content_after)).toString('utf8') : null,
    }));
  }
}
