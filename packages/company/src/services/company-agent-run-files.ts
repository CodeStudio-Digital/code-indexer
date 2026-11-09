import { toAgentRun, parseAgentRunFile } from './company-session-file-codecs.js';
import { dispatchSource } from './company-session-file-values.js';
import type { CompanyAgentRunFileRow, CreateCompanyAgentRunFileInput, UpdateCompanyAgentRunRuntimeInput } from './company-session-file-types.js';
import { asAgentRunId, asSessionId, type AgentRunId, type EntityRecord } from '@mcp/session-storage';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';

import { join } from 'node:path';

import type { AgentRunStatus } from '@mcp/company/types.js';
import { CompanySessionFileBase } from './company-session-file-base.js';

export class CompanyAgentRunFiles {
  constructor(private readonly context: CompanySessionFileBase) {}

  async createAgentRun(
    input: CreateCompanyAgentRunFileInput,
  ): Promise<CompanyAgentRunFileRow> {
    const coderSessionId = asSessionId(String(input.coder_session_id));
    const record = await this.context.entities.createAgentRun({
      ...(input.id ? { id: asAgentRunId(input.id) } : {}),
      relations: { coder_session_id: coderSessionId },
      data: {
        role: input.role,
        coder_session_id: coderSessionId,
        project_ids: [...new Set(input.project_ids)],
        provider: input.provider,
        model: input.model,
        configured_provider: input.configured_provider ?? input.provider,
        configured_model: input.configured_model ?? input.model,
        dispatch_source: input.dispatch_source ?? 'company',
        fallback_reason: input.fallback_reason ?? null,
        status: input.status ?? 'idle',
        status_message: input.status_message ?? '',
        archive_id: null,
        board_watermark_seq: 0,
      },
    });
    return toAgentRun(
      this.context.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async getAgentRun(
    id: AgentRunId | string,
  ): Promise<CompanyAgentRunFileRow | null> {
    const record = await this.context.entities.get('agentRun', asAgentRunId(String(id)));
    return record
      ? toAgentRun(
          this.context.companySessionId,
          record as EntityRecord<Record<string, unknown>>,
        )
      : null;
  }

  /**
   * Atomic entity replacement makes lock-free synchronous reads safe: readers
   * observe either the previous complete JSON file or the next one, never a
   * partially written record. Event-oriented Company APIs use this projection
   * where their public contract is intentionally synchronous.
   */
  getAgentRunSync(
    id: AgentRunId | string,
  ): CompanyAgentRunFileRow | null {
    const normalized = asAgentRunId(String(id));
    const path = join(
      this.context.location.bundle_path,
      'company',
      'agent-runs',
      `${normalized}.json`,
    );
    try {
      return parseAgentRunFile(this.context.companySessionId, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async listAgentRuns(): Promise<CompanyAgentRunFileRow[]> {
    const page = await this.context.entities.list('agentRun', {
      limit: 1_000,
      order: 'asc',
    });
    return page.items.map((record) =>
      toAgentRun(
        this.context.companySessionId,
        record as EntityRecord<Record<string, unknown>>,
      ),
    );
  }

  listAgentRunsSync(): CompanyAgentRunFileRow[] {
    const directory = join(
      this.context.location.bundle_path,
      'company',
      'agent-runs',
    );
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const rows: Array<{
      seq: number;
      row: CompanyAgentRunFileRow;
    }> = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Symbolic links are forbidden in Company agent runs: ${join(directory, entry.name)}`,
        );
      }
      if (
        !entry.isFile() ||
        !/^[0-9a-f-]{36}\.json$/i.test(entry.name)
      ) {
        continue;
      }
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Unsafe Company agent-run entity file ${path}`);
      }
      const record = JSON.parse(
        readFileSync(path, 'utf8'),
      ) as EntityRecord<Record<string, unknown>>;
      if (
        record.schemaVersion !== 1 ||
        record.kind !== 'company.agentRun' ||
        !Number.isSafeInteger(record.seq) ||
        record.seq < 1
      ) {
        throw new Error(`Invalid Company agent-run entity envelope ${path}`);
      }
      rows.push({
        seq: record.seq,
        row: toAgentRun(this.context.companySessionId, record),
      });
    }
    rows.sort((left, right) =>
      left.seq - right.seq || left.row.id.localeCompare(right.row.id),
    );
    return rows.map(({ row }) => row);
  }

  async updateAgentRunStatus(
    id: AgentRunId | string,
    status: AgentRunStatus,
    message?: string,
  ): Promise<CompanyAgentRunFileRow> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.context.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const record = await this.context.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        status,
        ...(message === undefined ? {} : { status_message: message }),
      },
    });
    return toAgentRun(
      this.context.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async updateAgentRunProvider(
    id: AgentRunId | string,
    provider: string,
    model: string,
    fallbackReason?: string | null,
  ): Promise<CompanyAgentRunFileRow> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.context.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const record = await this.context.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        provider,
        model,
        ...(fallbackReason === undefined
          ? {}
          : { fallback_reason: fallbackReason }),
      },
    });
    return toAgentRun(
      this.context.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  async updateAgentRunRuntimeSnapshot(
    id: AgentRunId | string,
    input: UpdateCompanyAgentRunRuntimeInput,
  ): Promise<CompanyAgentRunFileRow> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.context.entities.get('agentRun', normalized);
    if (!previous) throw new Error(`Unknown Company agent run ${normalized}`);
    const record = await this.context.entities.update('agentRun', normalized, {
      data: {
        ...previous.data,
        ...(input.configuredProvider === undefined
          ? {}
          : { configured_provider: input.configuredProvider }),
        ...(input.configuredModel === undefined
          ? {}
          : { configured_model: input.configuredModel }),
        ...(input.effectiveProvider === undefined
          ? {}
          : { provider: input.effectiveProvider }),
        ...(input.effectiveModel === undefined
          ? {}
          : { model: input.effectiveModel }),
        ...(input.dispatchSource === undefined
          ? {}
          : { dispatch_source: input.dispatchSource }),
        ...(input.fallbackReason === undefined
          ? {}
          : { fallback_reason: input.fallbackReason }),
      },
    });
    return toAgentRun(
      this.context.companySessionId,
      record as EntityRecord<Record<string, unknown>>,
    );
  }

  /** Recoverable deletion: move the independent agent-run record to the
   * session bundle trash. Permanent bundle cleanup remains a separate action. */
  async moveAgentRunToTrash(id: AgentRunId | string): Promise<boolean> {
    const normalized = asAgentRunId(String(id));
    const previous = await this.context.entities.get('agentRun', normalized);
    if (!previous) return false;
    await this.context.entities.moveToTrash('agentRun', normalized);
    return true;
  }
}
