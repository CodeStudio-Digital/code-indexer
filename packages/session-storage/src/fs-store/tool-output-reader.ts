import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ArtifactStore,
  assertPathHasNoLinksSync,
  isUuid,
  toolOutputRecordFileName,
  type CatalogEntry,
  type SessionId,
  type ToolOutputRecord,
} from '@mcp/session-storage';
import { projectConversation } from './conversation-codec.js';
import { FsSessionDirectory } from './session-directory.js';
import type {
  FsToolCallResult,
  FsToolOutputRead,
} from './types.js';

export class FsToolOutputReader {
  constructor(private readonly directory: FsSessionDirectory) {}

  private record(entry: CatalogEntry, callId: string): ToolOutputRecord | null {
    const path = join(
      entry.location.bundle_path,
      'tools_outputs',
      'calls',
      toolOutputRecordFileName(callId),
    );
    try {
      assertPathHasNoLinksSync(entry.location.bundle_path, path);
      const record = JSON.parse(readFileSync(path, 'utf8')) as ToolOutputRecord;
      if (
        record.schema_version !== 1 ||
        !isUuid(record.id) ||
        record.call_id !== callId
      ) {
        throw new Error(`Invalid tool output record ${path}`);
      }
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async get(
    id: SessionId | string,
    callId: string,
  ): Promise<FsToolOutputRead | null> {
    const entry = await this.directory.requireEntry(id);
    const record = this.record(entry, callId);
    if (!record) return null;
    const artifacts = new ArtifactStore({
      bundlePath: entry.location.bundle_path,
      sessionId: entry.session.id,
    });
    return {
      record,
      raw: record.raw ? artifacts.read(record.raw) : null,
      shaped: record.shaped ? artifacts.read(record.shaped) : null,
    };
  }

  async getResults(
    id: SessionId | string,
    toolUseIds: readonly string[],
  ): Promise<FsToolCallResult[]> {
    if (!toolUseIds.length) return [];
    const entry = await this.directory.requireEntry(id);
    const wanted = new Set(toolUseIds);
    const projection = projectConversation(
      await this.directory.repository.readConversation(entry.location, 'metadata'),
    );
    const artifacts = new ArtifactStore({
      bundlePath: entry.location.bundle_path,
      sessionId: entry.session.id,
    });
    return projection.toolCalls
      .filter((call) => wanted.has(call.tool_use_id))
      .map((call) => {
        const shaped = call.output.shaped ?? call.output.raw;
        if (!shaped) {
          throw new Error(`Tool output ${call.tool_use_id} has no payload`);
        }
        return {
          id: call.id,
          session_id: entry.session.id,
          message_seq: call.message_seq,
          tool_use_id: call.tool_use_id,
          tool_name: call.tool_name,
          result_text: Buffer.from(artifacts.read(shaped)).toString('utf8'),
          raw_result_text: call.output.raw
            ? Buffer.from(artifacts.read(call.output.raw)).toString('utf8')
            : null,
          is_error: call.is_error,
          duration_ms: call.duration_ms,
          output: call.output,
        };
      });
  }
}
