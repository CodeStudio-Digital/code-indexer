import type { Database as DB } from 'better-sqlite3';
import { renderChapterV3, renderResumeV3 } from '@mcp/code-agent/core/summarizer.js';
import {
  ExternalSessionError,
  type ExternalSessionSource,
  type ImportExternalSessionResult,
  type PersistExternalSessionInput,
} from '@mcp/code-agent/sessions/import/types.js';
import * as chapters from './chapters.js';
import * as core from './sessions-core.js';

function validTimestamp(value: string | null): string | null {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

export function findImported(
  db: DB,
  projectId: number,
  source: ExternalSessionSource,
  externalId: string,
): number | null {
  const row = db.prepare(`
    SELECT id FROM coder_sessions
    WHERE project_id = ? AND import_source = ? AND import_external_id = ?
  `).get(projectId, source, externalId) as { id: number } | undefined;
  return row?.id ?? null;
}

export function persist(db: DB, input: PersistExternalSessionInput): ImportExternalSessionResult {
  const tx = db.transaction((): ImportExternalSessionResult => {
    const duplicate = findImported(db, input.project_id, input.source, input.reference.external_id);
    if (duplicate != null) {
      throw new ExternalSessionError('duplicate_import', 'This source session was already imported', {
        session_id: duplicate,
      });
    }

    const session = core.create(db, {
      project_id: input.project_id,
      title: input.title,
      provider: input.provider,
      model: input.model,
      agent: input.agent,
    });
    const metadata = {
      ...input.document.diagnostics,
      ...input.diagnostics,
      source_path: input.reference.source_path,
      warnings: input.document.warnings,
      stats: input.document.stats,
    };
    db.prepare(`
      UPDATE coder_sessions SET
        import_source = ?, import_external_id = ?, import_fingerprint = ?,
        import_source_updated_at = ?, import_metadata_json = ?, imported_at = datetime('now')
      WHERE id = ?
    `).run(
      input.source,
      input.reference.external_id,
      input.document.fingerprint,
      validTimestamp(input.document.candidate.updated_at),
      JSON.stringify(metadata),
      session.id,
    );

    const insertMessage = db.prepare(`
      INSERT INTO coder_messages (
        session_id, role, content_json, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, is_meta, selected_skill_ids_json, created_at
      ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, NULL, COALESCE(?, datetime('now')))
    `);
    let firstMessageId = 0;
    let lastMessageId = 0;
    for (const entry of input.document.messages) {
      const result = insertMessage.run(
        session.id,
        entry.message.role,
        JSON.stringify(entry.message.content),
        validTimestamp(entry.created_at),
      );
      const id = Number(result.lastInsertRowid);
      if (!firstMessageId) firstMessageId = id;
      lastMessageId = id;
    }
    if (!firstMessageId || !lastMessageId) {
      throw new ExternalSessionError('empty_transcript', 'External session has no importable messages');
    }

    const chapterResult = chapters.commit(db, {
      sessionId: session.id,
      expectedBoundaryId: 0,
      startMessageId: firstMessageId,
      endMessageId: lastMessageId,
      source: 'import',
      trigger: 'external_import',
      title: input.summary.chapter.title,
      chapterJson: JSON.stringify(input.summary.chapter),
      chapterText: renderChapterV3(input.summary),
      resumeJson: JSON.stringify(input.summary.resume),
      resumeText: renderResumeV3(input.summary),
      version: input.summary.version,
      metricsJson: input.summary.metrics ? JSON.stringify(input.summary.metrics) : null,
    });
    if (chapterResult.status !== 'committed') {
      throw new Error(`Imported chapter was not committed: ${chapterResult.reason}`);
    }

    return {
      session_id: session.id,
      source: input.source,
      external_id: input.reference.external_id,
      fingerprint: input.document.fingerprint,
      imported_messages: input.document.messages.length,
      warnings: input.document.warnings,
      used_fallback_summary: Boolean(input.diagnostics?.used_fallback_summary),
    };
  });
  try {
    return tx();
  } catch (error) {
    if (error instanceof ExternalSessionError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed.*import_/i.test(error.message)) {
      throw new ExternalSessionError('duplicate_import', 'This source session was already imported');
    }
    throw error;
  }
}
