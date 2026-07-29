import {
  CompanySessionFileCollection,
  type CompanyOperationalSessionStore,
} from './company-session-file-collection.js';

export type ServiceTransitionKind = 'status' | 'health';

export interface ServiceTransitionRow {
  id: string;
  seq: number;
  sessionId: string;
  serviceId: string;
  kind: ServiceTransitionKind;
  fromState: string | null;
  toState: string;
  reason: string | null;
  actor: string;
  atMs: number;
}

export interface RecordServiceTransitionInput {
  sessionId: string;
  serviceId: string;
  kind: ServiceTransitionKind;
  fromState?: string | null;
  toState: string;
  reason?: string | null;
  actor: string;
  atMs?: number;
}

export interface ListServiceTransitionsOptions {
  serviceId?: string;
  beforeSeq?: number;
  limit?: number;
}

interface ServiceTransitionData {
  [key: string]: unknown;
  level: string;
  message: string;
  category: 'service-transition';
  service_id: string;
  transition_kind: ServiceTransitionKind;
  from_state: string | null;
  to_state: string;
  reason: string | null;
  actor: string;
  at_ms: number;
}

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

export class CompanyServiceTransitionsStore {
  private readonly files: CompanySessionFileCollection<ServiceTransitionData>;

  constructor(sessions: CompanyOperationalSessionStore) {
    this.files = new CompanySessionFileCollection(
      sessions,
      'logs',
      'company.log',
    );
  }

  record(input: RecordServiceTransitionInput): string {
    const atMs = input.atMs ?? Date.now();
    return this.files.create(input.sessionId, {
      data: {
        level: input.toState === 'error' || input.toState === 'down'
          ? 'error'
          : 'info',
        message: `${input.kind}:${input.fromState ?? 'unknown'}→${input.toState}`,
        category: 'service-transition',
        service_id: input.serviceId,
        transition_kind: input.kind,
        from_state: input.fromState ?? null,
        to_state: input.toState,
        reason: input.reason ?? null,
        actor: input.actor,
        at_ms: atMs,
      },
    }).id;
  }

  listPage(
    sessionId: string,
    opts: ListServiceTransitionsOptions = {},
  ): ServiceTransitionRow[] {
    const limit = Math.max(
      1,
      Math.min(opts.limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT),
    );
    return this.files
      .list(sessionId)
      .filter(
        (record) =>
          record.data.category === 'service-transition' &&
          (opts.serviceId === undefined ||
            record.data.service_id === opts.serviceId) &&
          (opts.beforeSeq === undefined || record.seq < opts.beforeSeq),
      )
      .sort((left, right) => right.seq - left.seq)
      .slice(0, limit)
      .map((record) => ({
        id: record.id,
        seq: record.seq,
        sessionId,
        serviceId: record.data.service_id,
        kind: record.data.transition_kind,
        fromState: record.data.from_state,
        toState: record.data.to_state,
        reason: record.data.reason,
        actor: record.data.actor,
        atMs: record.data.at_ms,
      }));
  }

  purgeSession(sessionId: string): number {
    const records = this.files
      .list(sessionId)
      .filter((record) => record.data.category === 'service-transition');
    for (const record of records) {
      this.files.moveToTrash(sessionId, record.id);
    }
    return records.length;
  }
}
