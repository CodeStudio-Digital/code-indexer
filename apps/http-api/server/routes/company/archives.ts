/**
 * Company session reset/archive routes backed exclusively by the owning
 * session bundle. An archive is one immutable identity record plus
 * `archive_id` stamps on the independent operational entity files.
 */
import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import {
  evictCompanyOrchestrator,
  getCompanyOrchestrator,
} from '../../../sse/companyOrchestrator.js';
import {
  notFound,
  parseCompanySessionIdParam,
  parseJsonBody,
  parseSessionRecordIdParam,
} from '../_helpers.js';
import {
  CompanySessionFiles,
} from '@mcp/company/services/CompanySessionFiles.js';
import {
  asSessionId,
  type CompanyEntityKind,
  type CompanySessionRepository,
  type EntityRecord,
} from '@mcp/session-storage';
import {
  appOwnedControlPlaneConflict,
  isAppOwnedCompanySession,
} from './runtime-capabilities.js';

interface ResetBody {
  reason?: string;
  archive_kanban?: boolean;
  teardown_sandbox?: boolean;
}

type JsonEntityRecord = EntityRecord<Record<string, unknown>>;

async function listAll(
  repository: CompanySessionRepository,
  kind: CompanyEntityKind,
): Promise<JsonEntityRecord[]> {
  const rows: JsonEntityRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await repository.list(kind, {
      limit: 1_000,
      ...(cursor ? { cursor } : {}),
    });
    rows.push(...page.items as JsonEntityRecord[]);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return rows;
}

function archiveIdOf(record: JsonEntityRecord): string | null {
  const value = record.data.archive_id ?? record.data.archiveId;
  return typeof value === 'string' ? value : null;
}

function entityRow(record: JsonEntityRecord): Record<string, unknown> {
  return {
    id: record.id,
    seq: record.seq,
    ...record.data,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

function archiveRow(
  sessionId: string,
  record: JsonEntityRecord,
): Record<string, unknown> {
  const stats =
    record.data.stats != null &&
    typeof record.data.stats === 'object' &&
    !Array.isArray(record.data.stats)
      ? record.data.stats
      : {};
  return {
    id: record.id,
    company_session_id: sessionId,
    archived_at: record.createdAt,
    reason:
      typeof record.data.reason === 'string' ? record.data.reason : null,
    included_kanban: record.data.included_kanban === true,
    included_sandbox: record.data.included_sandbox === true,
    stats,
  };
}

export function mountCompanyArchiveRoutes(app: Hono, deps: ServerDeps): void {
  app.post('/api/company/sessions/:id/reset', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const session = await deps.operationalSessionFiles.getCompanySession(id);
    if (!session) return notFound(c);
    if (await isAppOwnedCompanySession(deps.sessionStore, id)) {
      return appOwnedControlPlaneConflict(c, 'session reset/archive');
    }

    const body = await parseJsonBody<ResetBody>(c);
    const archiveKanban = body.archive_kanban !== false;
    const teardownSandbox = body.teardown_sandbox !== false;

    const orchestrator = getCompanyOrchestrator(id);
    if (orchestrator) {
      try {
        await orchestrator.abortAll({
          teardownSandbox,
          finalStatus: 'idle',
        });
      } catch (error) {
        console.warn(
          `[company/reset] abortAll failed for session ${id}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
      await evictCompanyOrchestrator(id);
    }

    try {
      const repository = await deps.operationalSessionFiles.company(id);
      const [agentRuns, board, masterPrompts, kanban] = await Promise.all([
        listAll(repository, 'agentRun'),
        listAll(repository, 'boardItem'),
        listAll(repository, 'masterPrompt'),
        archiveKanban ? listAll(repository, 'kanbanCard') : Promise.resolve([]),
      ]);
      const activeAgentRuns = agentRuns.filter((row) => archiveIdOf(row) == null);
      const activeBoard = board.filter((row) => archiveIdOf(row) == null);
      const activePrompts = masterPrompts.filter((row) => archiveIdOf(row) == null);
      const activeKanban = kanban.filter((row) => archiveIdOf(row) == null);

      const created = await repository.create('archive', {
        data: {
          reason: body.reason?.trim() || null,
          included_kanban: archiveKanban,
          included_sandbox: teardownSandbox,
          stats: {
            agent_runs: activeAgentRuns.length,
            board_entries: activeBoard.length,
            master_prompts: activePrompts.length,
            kanban_cards: activeKanban.length,
          },
        },
      });

      const stamp = async (
        kind: 'agentRun' | 'boardItem' | 'masterPrompt' | 'kanbanCard',
        record: JsonEntityRecord,
      ): Promise<void> => {
        const data: Record<string, unknown> = {
          ...record.data,
          archive_id: created.id,
        };
        if (
          kind === 'agentRun' &&
          typeof data.status === 'string' &&
          !['completed', 'failed', 'aborted'].includes(data.status)
        ) {
          data.status = 'aborted';
          data.status_message = `${
            typeof data.status_message === 'string'
              ? data.status_message
              : ''
          } [aborted by session reset]`.trim();
        }
        await repository.update(
          kind,
          record.id,
          { data } as never,
        );
      };

      for (const row of activeAgentRuns) await stamp('agentRun', row);
      for (const row of activeBoard) await stamp('boardItem', row);
      for (const row of activePrompts) await stamp('masterPrompt', row);
      for (const row of activeKanban) await stamp('kanbanCard', row);

      const files = new CompanySessionFiles({
        companySessionId: id,
        sessionStore: deps.sessionStore,
      });
      await files.setMasterSessionId(null);
      await files.updateSessionStatus('idle');
      if (session.parent_session_id != null) {
        await deps.sessionStore.setSessionArchived(asSessionId(id), true);
      }

      return c.json({
        archive: archiveRow(id, created as JsonEntityRecord),
      });
    } catch (error) {
      return c.json({
        error: `Archive failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }, 500);
    }
  });

  app.get('/api/company/sessions/:id/archives', async (c) => {
    const id = parseCompanySessionIdParam(c);
    if (!await deps.operationalSessionFiles.getCompanySession(id)) {
      return notFound(c);
    }
    const repository = await deps.operationalSessionFiles.company(id);
    const archives = await listAll(repository, 'archive');
    return c.json(
      archives
        .sort((left, right) =>
          Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
          right.id.localeCompare(left.id),
        )
        .map((row) => archiveRow(id, row)),
    );
  });

  app.get('/api/company/sessions/:id/archives/:archiveId', async (c) => {
    const id = parseCompanySessionIdParam(c);
    const archiveId = parseSessionRecordIdParam(c, 'archiveId');
    if (!await deps.operationalSessionFiles.getCompanySession(id)) {
      return notFound(c);
    }
    const repository = await deps.operationalSessionFiles.company(id);
    const archive = await repository.get('archive', archiveId);
    if (!archive) return notFound(c);
    const [agentRuns, board, kanban] = await Promise.all([
      listAll(repository, 'agentRun'),
      listAll(repository, 'boardItem'),
      archive.data.included_kanban === true
        ? listAll(repository, 'kanbanCard')
        : Promise.resolve([]),
    ]);
    const archivedAgentRuns = agentRuns.filter(
      (row) => archiveIdOf(row) === archiveId,
    );
    const archivedBoard = board.filter(
      (row) => archiveIdOf(row) === archiveId,
    );
    const archivedKanban = kanban.filter(
      (row) => archiveIdOf(row) === archiveId,
    );

    return c.json({
      archive: archiveRow(id, archive as JsonEntityRecord),
      agent_runs: archivedAgentRuns.map(entityRow),
      board: archivedBoard.map(entityRow),
      kanban: archivedKanban.map(entityRow),
      conversations_index: archivedAgentRuns.map((record) => ({
        agent_run_id: record.id,
        role: record.data.role,
        coder_session_id:
          record.data.coder_session_id ?? record.data.coderSessionId,
        provider: record.data.provider,
        model: record.data.model,
        status: record.data.status,
      })),
    });
  });
}
