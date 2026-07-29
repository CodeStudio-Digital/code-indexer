import {
  renderChapterV3,
  renderResumeV3,
} from '@mcp/code-agent/core/summarizer.js';
import {
  ExternalSessionError,
  type ExternalSessionSource,
  type ImportExternalSessionResult,
  type PersistExternalSessionInput,
} from '@mcp/code-agent/sessions/import/types.js';
import {
  type JsonValue,
  type SessionId,
} from '@mcp/session-storage';
import { FsConversationChapterRepository } from './conversation-chapter-repository.js';
import { toJsonValue } from './conversation-codec.js';
import { FsConversationWriter } from './conversation-writer.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsSessionEntityFiles } from './entity-files.js';

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function validTimestamp(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

export class FsExternalImportRepository {
  readonly #writer: FsConversationWriter;
  readonly #chapters: FsConversationChapterRepository;

  constructor(private readonly directory: FsSessionDirectory) {
    this.#writer = new FsConversationWriter(directory);
    this.#chapters = new FsConversationChapterRepository(
      directory,
      new FsSessionEntityFiles(directory),
    );
  }

  async findImportedSession(
    projectId: number,
    source: ExternalSessionSource,
    externalId: string,
  ): Promise<SessionId | null> {
    await this.directory.ensureCatalog();
    const entry = this.directory.catalog.list().find((candidate) => {
      if (
        candidate.session.kind !== 'coder' ||
        candidate.session.storage_scope.kind !== 'project' ||
        candidate.session.storage_scope.project_id !== projectId
      ) {
        return false;
      }
      const imported = record(candidate.session.metadata.external_import);
      return (
        imported.source === source &&
        imported.external_id === externalId
      );
    });
    return entry?.session.id ?? null;
  }

  importExternalSession(
    input: PersistExternalSessionInput,
  ): Promise<ImportExternalSessionResult> {
    if (input.document.messages.length === 0) {
      return Promise.reject(
        new ExternalSessionError(
          'empty_transcript',
          'External session has no importable messages',
        ),
      );
    }
    const lockKey =
      `external-import:${input.project_id}:${input.source}:` +
      input.reference.external_id;
    return this.directory.runMutation(lockKey, async () => {
      const duplicate = await this.findImportedSession(
        input.project_id,
        input.source,
        input.reference.external_id,
      );
      if (duplicate) {
        throw new ExternalSessionError(
          'duplicate_import',
          'This source session was already imported',
          { session_id: duplicate },
        );
      }
      const importedAt = new Date().toISOString();
      const metadata = toJsonValue({
        external_import: {
          source: input.source,
          external_id: input.reference.external_id,
          fingerprint: input.document.fingerprint,
          source_path: input.reference.source_path,
          source_updated_at: validTimestamp(
            input.document.candidate.updated_at,
          ),
          imported_at: importedAt,
          allow_project_mismatch:
            input.allow_project_mismatch === true,
          diagnostics: {
            ...input.document.diagnostics,
            ...input.diagnostics,
            warnings: input.document.warnings,
            stats: input.document.stats,
          },
        },
      }) as Readonly<Record<string, JsonValue>>;
      const session = await this.directory.createSession({
        project_id: input.project_id,
        title: input.title,
        provider: input.provider,
        model: input.model,
        agent: input.agent,
        metadata,
      });
      try {
        let firstSeq = 0;
        let lastSeq = 0;
        for (let index = 0; index < input.document.messages.length; index++) {
          const entry = input.document.messages[index]!;
          const seq = await this.#writer.appendMessage({
            session_id: session.id,
            message: entry.message,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
            operation_id:
              `external-import:${input.document.fingerprint}:message:${index}`,
          });
          if (firstSeq === 0) firstSeq = seq;
          lastSeq = seq;
        }
        const chapter = await this.#chapters.commit({
          sessionId: session.id,
          expectedBoundarySeq: 0,
          startMessageSeq: firstSeq,
          endMessageSeq: lastSeq,
          source: 'import',
          trigger: 'external_import',
          title: input.summary.chapter.title,
          chapterJson: JSON.stringify(input.summary.chapter),
          chapterText: renderChapterV3(input.summary),
          resumeJson: JSON.stringify(input.summary.resume),
          resumeText: renderResumeV3(input.summary),
          version: input.summary.version,
          metricsJson: input.summary.metrics
            ? JSON.stringify(input.summary.metrics)
            : null,
          operation_id:
            `external-import:${input.document.fingerprint}:chapter`,
        });
        if (chapter.status !== 'committed') {
          throw new Error(
            `Imported chapter was not committed: ${chapter.reason}`,
          );
        }
        return {
          session_id: session.id,
          source: input.source,
          external_id: input.reference.external_id,
          fingerprint: input.document.fingerprint,
          imported_messages: input.document.messages.length,
          warnings: input.document.warnings,
          used_fallback_summary:
            input.diagnostics?.used_fallback_summary === true,
        };
      } catch (error) {
        const created = await this.directory.entry(session.id);
        if (created) {
          await this.directory.repository.trashSession(created.location);
        }
        throw error;
      }
    });
  }
}

export type FsExternalImportApi = Pick<
  FsExternalImportRepository,
  'findImportedSession' | 'importExternalSession'
>;

export function installExternalImportApi(
  target: object,
  directory: FsSessionDirectory,
): void {
  const imports = new FsExternalImportRepository(directory);
  for (const name of [
    'findImportedSession',
    'importExternalSession',
  ] as const) {
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: imports[name].bind(imports),
    });
  }
}
