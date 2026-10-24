/**
 * Filesystem-backed per-test QA outcomes.
 *
 * Each result is an independent immutable-by-convention JSON entity in the
 * same Company bundle as its run. Mutating the optional Kanban link rewrites
 * only that result file through the owning session writer.
 */
import {
  CompanySessionRepository,
  assertUuid,
  type CatalogEntry,
  type CompanyQaResultData,
  type EntityRecord,
} from '@mcp/session-storage';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type {
  QaTestResult,
  QaTestResultInsert,
  QaTestStatus,
} from '../types.js';
import type { IQaTestResultStore } from './interfaces.js';

const DEFAULT_RECENT_LIMIT = 20;
const MAX_RECENT_LIMIT = 200;

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function testStatus(value: unknown): QaTestStatus {
  return value === 'failed' ||
    value === 'skipped' ||
    value === 'timed-out' ||
    value === 'interrupted'
    ? value
    : 'passed';
}

function hydrate(
  record: EntityRecord<CompanyQaResultData>,
): QaTestResult {
  const data = record.data;
  return {
    id: assertUuid(record.id, 'QA result id'),
    seq: record.seq,
    run_id: assertUuid(String(data.run_id), 'QA result run id'),
    spec_file:
      typeof data.spec_file === 'string' ? data.spec_file : '',
    test_name:
      typeof data.test_name === 'string' ? data.test_name : '',
    status: testStatus(data.status),
    duration_ms:
      typeof data.duration_ms === 'number' &&
      Number.isFinite(data.duration_ms)
        ? data.duration_ms
        : null,
    error: nullableString(data.error),
    trace_path: nullableString(data.trace_path),
    screenshot_path: nullableString(data.screenshot_path),
    video_path: nullableString(data.video_path),
    summary_md_path: nullableString(data.summary_md_path),
    kanban_card_id: nullableString(data.kanban_card_id),
    created_at:
      typeof data.created_at === 'string'
        ? data.created_at
        : record.createdAt,
  };
}

function isCompanyEntry(entry: CatalogEntry): boolean {
  return entry.session.kind === 'company' ||
    entry.session.kind === 'app_studio';
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_RECENT_LIMIT;
  }
  return Math.min(MAX_RECENT_LIMIT, Math.floor(raw));
}

export class QaTestResultStore implements IQaTestResultStore {
  private readonly repositories = new Map<string, CompanySessionRepository>();
  private readonly runOwners = new Map<string, string>();
  private readonly resultOwners = new Map<string, string>();

  constructor(private readonly sessionStore: FsSessionStore) {}

  close(): void {
    this.repositories.clear();
    this.runOwners.clear();
    this.resultOwners.clear();
  }

  private repository(entry: CatalogEntry): CompanySessionRepository {
    let repository = this.repositories.get(entry.location.bundle_path);
    if (!repository) {
      repository = new CompanySessionRepository({
        sessionRoot: entry.location.bundle_path,
      });
      this.repositories.set(entry.location.bundle_path, repository);
    }
    return repository;
  }

  private async ownerForRun(runId: string): Promise<CatalogEntry | null> {
    const normalized = assertUuid(runId, 'QA run id');
    const cached = this.runOwners.get(normalized);
    if (cached) {
      const entry = this.sessionStore.catalog.get(cached);
      if (
        entry &&
        isCompanyEntry(entry) &&
        await this.repository(entry).get('qaRun', normalized)
      ) {
        return entry;
      }
      this.runOwners.delete(normalized);
    }
    for (const entry of this.sessionStore.catalog.list()) {
      if (!isCompanyEntry(entry)) continue;
      if (await this.repository(entry).get('qaRun', normalized)) {
        this.runOwners.set(normalized, String(entry.session.id));
        return entry;
      }
    }
    return null;
  }

  private async locateResult(resultId: string): Promise<{
    entry: CatalogEntry;
    repository: CompanySessionRepository;
    record: EntityRecord<CompanyQaResultData>;
  } | null> {
    const normalized = assertUuid(resultId, 'QA result id');
    const cached = this.resultOwners.get(normalized);
    if (cached) {
      const entry = this.sessionStore.catalog.get(cached);
      if (entry && isCompanyEntry(entry)) {
        const repository = this.repository(entry);
        const record = await repository.get('qaResult', normalized);
        if (record) return { entry, repository, record };
      }
      this.resultOwners.delete(normalized);
    }
    for (const entry of this.sessionStore.catalog.list()) {
      if (!isCompanyEntry(entry)) continue;
      const repository = this.repository(entry);
      const record = await repository.get('qaResult', normalized);
      if (!record) continue;
      this.resultOwners.set(normalized, String(entry.session.id));
      return { entry, repository, record };
    }
    return null;
  }

  private async allResults(
    entry: CatalogEntry,
  ): Promise<EntityRecord<CompanyQaResultData>[]> {
    const repository = this.repository(entry);
    const records: EntityRecord<CompanyQaResultData>[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list('qaResult', {
        cursor,
        limit: 1_000,
        order: 'asc',
      });
      records.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    for (const record of records) {
      this.resultOwners.set(record.id, String(entry.session.id));
      this.runOwners.set(
        String(record.data.run_id),
        String(entry.session.id),
      );
    }
    return records;
  }

  async recordResult(input: QaTestResultInsert): Promise<string> {
    const entry = await this.ownerForRun(input.run_id);
    if (!entry) {
      throw new Error(
        `Unknown filesystem QA run ${input.run_id}; no SQLite fallback is available`,
      );
    }
    const repository = this.repository(entry);
    const now = new Date().toISOString();
    const record = await this.sessionStore.runSessionMutation(
      entry.session.id,
      () =>
        repository.createQaResult({
          relations: { run_id: assertUuid(input.run_id, 'QA run id') },
          data: {
            run_id: input.run_id,
            spec_file: input.spec_file,
            test_name: input.test_name,
            status: input.status,
            duration_ms: input.duration_ms,
            error: input.error,
            trace_path: input.trace_path,
            screenshot_path: input.screenshot_path ?? null,
            video_path: input.video_path ?? null,
            summary_md_path: input.summary_md_path ?? null,
            kanban_card_id: null,
            created_at: now,
          },
        }),
    );
    this.resultOwners.set(record.id, String(entry.session.id));
    return record.id;
  }

  async listResults(runId: string): Promise<QaTestResult[]> {
    const entry = await this.ownerForRun(runId);
    if (!entry) return [];
    const page = await this.repository(entry).listByRelation(
      'qaResult',
      'run_id',
      assertUuid(runId, 'QA run id'),
      { limit: 1_000, order: 'asc' },
    );
    return page.items.map(hydrate);
  }

  async listFailures(runId: string): Promise<QaTestResult[]> {
    return (await this.listResults(runId)).filter(
      (result) =>
        result.status === 'failed' ||
        result.status === 'timed-out' ||
        result.status === 'interrupted',
    );
  }

  async recentForTest(opts: {
    spec_file: string;
    test_name: string;
    limit?: number;
  }): Promise<QaTestResult[]> {
    const rows: QaTestResult[] = [];
    for (const entry of this.sessionStore.catalog.list()) {
      if (!isCompanyEntry(entry)) continue;
      rows.push(
        ...(await this.allResults(entry))
          .map(hydrate)
          .filter(
            (result) =>
              result.spec_file === opts.spec_file &&
              result.test_name === opts.test_name,
          ),
      );
    }
    return rows
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at) ||
          right.seq - left.seq,
      )
      .slice(0, clampLimit(opts.limit));
  }

  async findRecentResultByName(opts: {
    spec_file: string;
    test_name: string;
  }): Promise<QaTestResult | null> {
    return (
      (await this.recentForTest({ ...opts, limit: MAX_RECENT_LIMIT }))
        .find((result) => result.kanban_card_id != null) ?? null
    );
  }

  async setKanbanCardId(
    resultId: string,
    cardId: string | null,
  ): Promise<void> {
    const located = await this.locateResult(resultId);
    if (!located) return;
    const normalizedCardId =
      cardId == null ? null : assertUuid(cardId, 'QA Kanban card id');
    await this.sessionStore.runSessionMutation(
      located.entry.session.id,
      async () => {
        const latest = await located.repository.get(
          'qaResult',
          resultId,
        );
        if (!latest) return;
        await located.repository.update('qaResult', resultId, {
          data: {
            ...latest.data,
            kanban_card_id: normalizedCardId,
          },
        });
      },
    );
  }
}
