/**
 * Filesystem-backed QA run lifecycle.
 *
 * Every run is an independent JSON entity under the owning Company bundle.
 * The in-memory session catalog is the only cross-session lookup mechanism;
 * there is deliberately no SQLite index, compatibility read, or dual-write.
 */
import {
  CompanySessionRepository,
  assertContainedPath,
  asCompanySessionId,
  assertUuid,
  ensureDirectoryTreeNoLinks,
  type CatalogEntry,
  type CompanyQaRunData,
  type EntityRecord,
} from '@mcp/session-storage';
import { join } from 'node:path';
import type { FsSessionStore } from '@mcp/session-storage/fs-store/fs-session-store.js';
import type {
  QaRun,
  QaRunCompletion,
  QaRunInsert,
  QaRunStatus,
  QaRunTrigger,
} from '../types.js';
import type { IQaTestRunStore } from './interfaces.js';

interface LocatedQaRun {
  entry: CatalogEntry;
  repository: CompanySessionRepository;
  record: EntityRecord<CompanyQaRunData>;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function runStatus(value: unknown): QaRunStatus {
  return value === 'completed' ||
    value === 'aborted' ||
    value === 'error'
    ? value
    : 'running';
}

function runTrigger(value: unknown): QaRunTrigger {
  return value === 'human' || value === 'watcher' ? value : 'agent';
}

function hydrate(
  companySessionId: string,
  record: EntityRecord<CompanyQaRunData>,
): QaRun {
  const data = record.data;
  return {
    id: assertUuid(record.id, 'QA run id'),
    seq: record.seq,
    company_session_id: asCompanySessionId(companySessionId),
    agent_run_id: nullableString(data.agent_run_id),
    suite: typeof data.suite === 'string' ? data.suite : '',
    service_id:
      typeof data.service_id === 'string' && data.service_id.length > 0
        ? data.service_id
        : 'main',
    status: runStatus(data.status),
    started_at:
      typeof data.started_at === 'string'
        ? data.started_at
        : record.createdAt,
    completed_at: nullableString(data.completed_at),
    passed: numberValue(data.passed),
    failed: numberValue(data.failed),
    skipped: numberValue(data.skipped),
    duration_ms:
      typeof data.duration_ms === 'number' &&
      Number.isFinite(data.duration_ms)
        ? data.duration_ms
        : null,
    trigger: runTrigger(data.trigger),
    report_persisted_path: nullableString(data.report_persisted_path),
    kanban_feature_card_id: nullableString(
      data.kanban_feature_card_id,
    ),
    last_error: nullableString(data.last_error),
    error_class: nullableString(data.error_class),
    last_event_at: nullableString(data.last_event_at),
    plan_gate: nullableString(data.plan_gate),
  };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.floor(raw));
}

function isCompanyEntry(entry: CatalogEntry): boolean {
  return entry.session.kind === 'company' ||
    entry.session.kind === 'app_studio';
}

export class QaTestRunStore implements IQaTestRunStore {
  private readonly repositories = new Map<string, CompanySessionRepository>();
  private readonly runOwners = new Map<string, string>();

  constructor(private readonly sessionStore: FsSessionStore) {}

  close(): void {
    this.repositories.clear();
    this.runOwners.clear();
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

  private entryForSession(companySessionId: string): CatalogEntry {
    const normalized = asCompanySessionId(companySessionId);
    const entry = this.sessionStore.catalog.get(normalized);
    if (!entry || !isCompanyEntry(entry)) {
      throw new Error(
        `Unknown filesystem Company session ${normalized}; no SQLite fallback is available`,
      );
    }
    return entry;
  }

  private async listRecords(
    entry: CatalogEntry,
  ): Promise<EntityRecord<CompanyQaRunData>[]> {
    const repository = this.repository(entry);
    const records: EntityRecord<CompanyQaRunData>[] = [];
    let cursor: string | undefined;
    do {
      const page = await repository.list('qaRun', {
        cursor,
        limit: 1_000,
        order: 'asc',
      });
      records.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    for (const record of records) {
      this.runOwners.set(record.id, String(entry.session.id));
    }
    return records;
  }

  private async locateRun(runId: string): Promise<LocatedQaRun | null> {
    const normalized = assertUuid(runId, 'QA run id');
    const cachedOwner = this.runOwners.get(normalized);
    if (cachedOwner) {
      const entry = this.sessionStore.catalog.get(cachedOwner);
      if (entry && isCompanyEntry(entry)) {
        const repository = this.repository(entry);
        const record = await repository.get('qaRun', normalized);
        if (record) return { entry, repository, record };
      }
      this.runOwners.delete(normalized);
    }
    for (const entry of this.sessionStore.catalog.list()) {
      if (!isCompanyEntry(entry)) continue;
      const repository = this.repository(entry);
      const record = await repository.get('qaRun', normalized);
      if (!record) continue;
      this.runOwners.set(normalized, String(entry.session.id));
      return { entry, repository, record };
    }
    return null;
  }

  async startRun(input: QaRunInsert): Promise<QaRun> {
    const entry = this.entryForSession(input.company_session_id);
    const repository = this.repository(entry);
    const now = new Date().toISOString();
    const record = await this.sessionStore.runSessionMutation(
      entry.session.id,
      () =>
        repository.createQaRun({
          relations: {
            ...(input.agent_run_id
              ? {
                  agent_run_id: assertUuid(
                    input.agent_run_id,
                    'QA agent run id',
                  ),
                }
              : {}),
            ...(input.kanban_feature_card_id
              ? {
                  kanban_feature_card_id: assertUuid(
                    input.kanban_feature_card_id,
                    'QA feature card id',
                  ),
                }
              : {}),
          },
          data: {
            status: 'running',
            agent_run_id: input.agent_run_id,
            suite: input.suite,
            service_id: input.service_id ?? 'main',
            started_at: now,
            completed_at: null,
            passed: 0,
            failed: 0,
            skipped: 0,
            duration_ms: null,
            trigger: input.trigger,
            report_persisted_path: null,
            kanban_feature_card_id:
              input.kanban_feature_card_id ?? null,
            last_error: null,
            error_class: null,
            last_event_at: null,
            plan_gate: input.plan_gate ?? null,
          },
        }),
    );
    this.runOwners.set(record.id, String(entry.session.id));
    return hydrate(String(entry.session.id), record);
  }

  async completeRun(
    runId: string,
    completion: QaRunCompletion,
  ): Promise<QaRun | null> {
    const located = await this.locateRun(runId);
    if (!located) return null;
    const current = hydrate(String(located.entry.session.id), located.record);
    if (current.status !== 'running') return current;
    const updated = await this.sessionStore.runSessionMutation(
      located.entry.session.id,
      async () => {
        const latest = await located.repository.get('qaRun', current.id);
        if (!latest || runStatus(latest.data.status) !== 'running') {
          return latest;
        }
        return located.repository.update('qaRun', current.id, {
          data: {
            ...latest.data,
            status: completion.status,
            completed_at: new Date().toISOString(),
            passed: completion.passed,
            failed: completion.failed,
            skipped: completion.skipped,
            duration_ms: completion.duration_ms,
            last_error: completion.last_error ?? null,
            error_class: completion.error_class ?? null,
          },
        });
      },
    );
    return updated
      ? hydrate(String(located.entry.session.id), updated)
      : null;
  }

  async getRun(runId: string): Promise<QaRun | null> {
    const located = await this.locateRun(runId);
    return located
      ? hydrate(String(located.entry.session.id), located.record)
      : null;
  }

  async listRuns(opts: {
    company_session_id: string;
    service_id?: string;
    limit?: number;
    offset?: number;
  }): Promise<QaRun[]> {
    const entry = this.entryForSession(opts.company_session_id);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const limit = clampLimit(opts.limit);
    return (await this.listRecords(entry))
      .map((record) => hydrate(String(entry.session.id), record))
      .filter(
        (run) =>
          opts.service_id == null ||
          run.service_id === opts.service_id,
      )
      .sort(
        (left, right) =>
          Date.parse(right.started_at) - Date.parse(left.started_at) ||
          right.seq - left.seq,
      )
      .slice(offset, offset + limit);
  }

  async getActiveRun(
    companySessionId: string,
    serviceId?: string,
  ): Promise<QaRun | null> {
    const entry = this.entryForSession(companySessionId);
    return (await this.listRecords(entry))
      .map((record) => hydrate(String(entry.session.id), record))
      .filter(
        (run) =>
          run.status === 'running' &&
          (serviceId == null || run.service_id === serviceId),
      )
      .sort(
        (left, right) =>
          Date.parse(right.started_at) - Date.parse(left.started_at) ||
          right.seq - left.seq,
      )[0] ?? null;
  }

  async recoverStaleRuns(): Promise<{ recovered: number }> {
    let recovered = 0;
    for (const run of await this.listRunningRuns()) {
      const updated = await this.completeRun(run.id, {
        status: 'aborted',
        passed: run.passed,
        failed: run.failed,
        skipped: run.skipped,
        duration_ms: run.duration_ms,
        last_error: 'Interrupted by host restart',
        error_class: 'aborted',
      });
      if (updated?.status === 'aborted') recovered += 1;
    }
    return { recovered };
  }

  async findStaleRunningRuns(maxAgeMs: number): Promise<QaRun[]> {
    const threshold = Date.now() - Math.max(0, maxAgeMs);
    const stale: QaRun[] = [];
    for (const entry of this.sessionStore.catalog.list()) {
      if (!isCompanyEntry(entry)) continue;
      const repository = this.repository(entry);
      for (const record of await this.listRecords(entry)) {
        const run = hydrate(String(entry.session.id), record);
        if (run.status !== 'running') continue;
        const progressAt = Math.max(
          Date.parse(run.started_at),
          run.last_event_at == null ? 0 : Date.parse(run.last_event_at),
        );
        if (progressAt > threshold) continue;
        const results = await repository.listByRelation(
          'qaResult',
          'run_id',
          run.id,
          { limit: 1, order: 'asc' },
        );
        if (results.items.length === 0) stale.push(run);
      }
    }
    return stale.sort(
      (left, right) =>
        Date.parse(left.started_at) - Date.parse(right.started_at) ||
        left.seq - right.seq,
    );
  }

  async touchLastEvent(runId: string): Promise<void> {
    const located = await this.locateRun(runId);
    if (!located || runStatus(located.record.data.status) !== 'running') {
      return;
    }
    await this.sessionStore.runSessionMutation(
      located.entry.session.id,
      async () => {
        const latest = await located.repository.get('qaRun', runId);
        if (!latest || runStatus(latest.data.status) !== 'running') return;
        await located.repository.update('qaRun', runId, {
          data: {
            ...latest.data,
            last_event_at: new Date().toISOString(),
          },
        });
      },
    );
  }

  async listRunningRuns(): Promise<QaRun[]> {
    const runs: QaRun[] = [];
    for (const entry of this.sessionStore.catalog.list()) {
      if (!isCompanyEntry(entry)) continue;
      runs.push(
        ...(await this.listRecords(entry))
          .map((record) => hydrate(String(entry.session.id), record))
          .filter((run) => run.status === 'running'),
      );
    }
    return runs.sort(
      (left, right) =>
        Date.parse(left.started_at) - Date.parse(right.started_at) ||
        left.seq - right.seq,
    );
  }

  async setReportPersistedPath(
    runId: string,
    absolutePath: string | null,
  ): Promise<void> {
    const located = await this.locateRun(runId);
    if (!located) return;
    await this.sessionStore.runSessionMutation(
      located.entry.session.id,
      async () => {
        const latest = await located.repository.get('qaRun', runId);
        if (!latest) return;
        await located.repository.update('qaRun', runId, {
          data: {
            ...latest.data,
            report_persisted_path: absolutePath,
          },
        });
      },
    );
  }

  async withRunArtifactDirectory<T>(
    companySessionId: string,
    runId: string,
    task: (absoluteDirectory: string) => Promise<T>,
  ): Promise<T> {
    const normalizedSessionId = asCompanySessionId(companySessionId);
    const located = await this.locateRun(runId);
    if (!located) {
      throw new Error(`Unknown filesystem QA run ${runId}`);
    }
    if (String(located.entry.session.id) !== String(normalizedSessionId)) {
      throw new Error(
        `QA run ${runId} does not belong to Company session ${normalizedSessionId}`,
      );
    }
    const directory = join(
      located.entry.location.bundle_path,
      'company',
      'qa-artifacts',
      assertUuid(runId, 'QA run id'),
    );
    assertContainedPath(located.entry.location.bundle_path, directory);
    return this.sessionStore.runSessionMutation(
      located.entry.session.id,
      async () => {
        await ensureDirectoryTreeNoLinks(
          located.entry.location.bundle_path,
          directory,
        );
        return task(directory);
      },
    );
  }

  async countWatchdogKills(opts: {
    company_session_id: string;
    windowMs: number;
  }): Promise<number> {
    const threshold = Date.now() - Math.max(0, opts.windowMs);
    const entry = this.entryForSession(opts.company_session_id);
    return (await this.listRecords(entry))
      .map((record) => hydrate(String(entry.session.id), record))
      .filter(
      (run) =>
        run.status === 'error' &&
        run.last_error?.startsWith(
          'No events received from reporter',
        ) === true &&
        run.completed_at != null &&
        Date.parse(run.completed_at) >= threshold,
      ).length;
  }
}
