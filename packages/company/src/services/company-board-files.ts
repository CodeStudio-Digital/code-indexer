import { toBoardEntry, parseBoardItemFile } from './company-session-file-codecs.js';
import { nonNegativeSafeInteger } from './company-session-file-values.js';
import type { ReadCompanyBoardFileOptions } from './company-session-file-types.js';
import { asAgentRunId, type AgentRunId, type EntityRecord } from '@mcp/session-storage';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import type { BoardEntry, BoardKind } from '@mcp/company/types.js';
import { CompanySessionFileBase } from './company-session-file-base.js';
import { CompanyAgentRunFiles } from './company-agent-run-files.js';

export class CompanyBoardFiles {
  constructor(private readonly context: CompanySessionFileBase, private readonly agentRuns: CompanyAgentRunFiles) {}

  private nextBoardSequence: number | null = null;

  createBoardEntry(input: {
    authorRole: string;
    agentRunId: AgentRunId | string | null;
    kind: BoardKind;
    content: string;
    mentions?: readonly string[];
  }): BoardEntry {
    const normalizedAgentRunId =
      input.agentRunId == null
        ? null
        : asAgentRunId(String(input.agentRunId));
    const directory = this.context.ensureCompanyEntityDirectorySync('board-items');
    const seq =
      this.nextBoardSequence ??
      (
        this.scanBoardEntriesSync(undefined, true).reduce(
          (max, entry) => Math.max(max, entry.seq),
          0,
        ) + 1
      );
    const now = new Date().toISOString();
    const record: EntityRecord<Record<string, unknown>> = {
      schemaVersion: 1,
      id: randomUUID(),
      kind: 'company.boardItem',
      seq,
      operationId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      relations:
        normalizedAgentRunId == null
          ? {}
          : { agent_run_id: normalizedAgentRunId },
      data: {
        author_role: input.authorRole,
        agent_run_id: normalizedAgentRunId,
        kind: input.kind,
        content: input.content,
        mentions: [...new Set(input.mentions ?? [])],
        archive_id: null,
      },
    };
    this.context.writeCompanyEntityRecordSync(directory, record, true);
    this.nextBoardSequence = seq + 1;
    return toBoardEntry(this.context.companySessionId, record);
  }

  private scanBoardEntriesSync(
    kind?: BoardKind,
    includeArchived = false,
  ): BoardEntry[] {
    const directory = join(
      this.context.location.bundle_path,
      'company',
      'board-items',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const rows: BoardEntry[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company board items: ${path}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const row = parseBoardItemFile(this.context.companySessionId, path);
      if (!includeArchived && row.archive_id != null) continue;
      if (kind && row.kind !== kind) continue;
      rows.push(row);
    }
    rows.sort(
      (left, right) =>
        left.seq - right.seq || left.id.localeCompare(right.id),
    );
    return rows;
  }

  listBoardEntriesSync(
    opts: ReadCompanyBoardFileOptions = {},
  ): BoardEntry[] {
    const limit = opts.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError('Company board limit must be between 1 and 1000');
    }
    if (
      opts.sinceSeq !== undefined &&
      (
        !Number.isSafeInteger(opts.sinceSeq) ||
        opts.sinceSeq < 0
      )
    ) {
      throw new TypeError('Company board sinceSeq must be a non-negative integer');
    }

    const rows = this.scanBoardEntriesSync(opts.kind).filter(
      (entry) =>
        opts.sinceSeq === undefined || entry.seq > opts.sinceSeq,
    );
    return opts.sinceSeq === undefined
      ? rows.slice(Math.max(0, rows.length - limit))
      : rows.slice(0, limit);
  }

  getAgentBoardWatermarkSync(
    agentRunId: AgentRunId | string,
  ): number {
    return this.agentRuns.getAgentRunSync(agentRunId)?.board_watermark_seq ?? 0;
  }

  async setAgentBoardWatermark(
    agentRunId: AgentRunId | string,
    lastSeenBoardSeq: number,
  ): Promise<number> {
    if (
      !Number.isSafeInteger(lastSeenBoardSeq) ||
      lastSeenBoardSeq < 0
    ) {
      throw new TypeError('Company board watermark must be a non-negative integer');
    }
    const normalized = asAgentRunId(String(agentRunId));
    const previous = await this.context.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const current = nonNegativeSafeInteger(
      previous.data.board_watermark_seq,
    );
    const next = Math.max(current, lastSeenBoardSeq);
    if (next === current) return current;
    await this.context.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        board_watermark_seq: next,
      },
    });
    return next;
  }

  listUnreadBoardCountsSync(): Array<{
    agentRunId: AgentRunId;
    role: string;
    unreadCount: number;
  }> {
    const entries = this.scanBoardEntriesSync();
    return this.agentRuns.listAgentRunsSync().map((run) => ({
      agentRunId: run.id,
      role: run.role,
      unreadCount: entries.filter(
        (entry) =>
          entry.seq > run.board_watermark_seq &&
          entry.agent_run_id !== run.id,
      ).length,
    }));
  }
}
