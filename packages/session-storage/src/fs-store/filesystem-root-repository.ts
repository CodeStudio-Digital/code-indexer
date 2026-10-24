import { isAbsolute, normalize, resolve } from 'node:path';
import {
  asSessionId,
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import type { FsSessionFilesystemRoot } from './operational-types.js';

interface FilesystemRootData {
  root_path: string;
  access: 'read' | 'write';
}

function canonicalPath(path: string): string {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new TypeError('filesystem root must be an absolute path');
  }
  const value = normalize(resolve(path));
  return process.platform === 'win32'
    ? value.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
    : value;
}

function row(
  sessionId: SessionId,
  item: FsEntityEnvelope<JsonValue>,
): FsSessionFilesystemRoot {
  const data = item.data as unknown as FilesystemRootData;
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    session_id: sessionId,
    root_path: data.root_path,
    access: data.access,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

export class FsFilesystemRootRepository {
  constructor(private readonly entities: FsSessionEntityFiles) {}

  async list(
    sessionId: SessionId | string,
  ): Promise<FsSessionFilesystemRoot[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'inputs',
      'filesystem_root',
    )).map((item) => row(asSessionId(String(sessionId)), item));
  }

  async upsert(
    sessionId: SessionId | string,
    rootPath: string,
    access: 'read' | 'write',
    operationId?: string,
  ): Promise<FsSessionFilesystemRoot> {
    const normalized = canonicalPath(rootPath);
    const roots = await this.entities.list<JsonValue>(
      sessionId,
      'inputs',
      'filesystem_root',
    );
    const existing = roots.find((item) => {
      const path = (item.data as unknown as FilesystemRootData).root_path;
      return process.platform === 'win32'
        ? path.toLowerCase() === normalized.toLowerCase()
        : path === normalized;
    });
    const operationKey = {
      action: 'upsert_filesystem_root',
      root_path: normalized,
      access,
    };
    const written = existing
      ? await this.entities.update<FilesystemRootData>(
          sessionId,
          'inputs',
          existing.id,
          () => ({ root_path: normalized, access }),
          {
            operation_id: operationId,
            operation_key: operationKey,
          },
        )
      : await this.entities.create(sessionId, 'inputs', {
          kind: 'filesystem_root',
          data: { root_path: normalized, access },
          operation_id: operationId,
          operation_key: operationKey,
        });
    return row(asSessionId(String(sessionId)), written!);
  }

  async remove(
    sessionId: SessionId | string,
    rootId: string,
    operationId?: string,
  ): Promise<boolean> {
    return (
      (await this.entities.update(
        sessionId,
        'inputs',
        rootId,
        (data) => data,
        {
          delete: true,
          operation_id: operationId,
          operation_key: {
            action: 'remove_filesystem_root',
            root_id: rootId,
          },
        },
      )) != null
    );
  }
}
