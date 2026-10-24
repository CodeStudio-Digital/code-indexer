import type { Awaitable } from './session-snapshot-port.js';

export type ReviewFateOutcome = 'accepted' | 'dismissed' | 'reedited' | 'ignored';

export interface ReviewFateInput<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  comment_id: RecordId;
  session_kind: string;
  session_id: SessionKey;
  category: string;
  severity: string | null;
  file_path: string;
  outcome: ReviewFateOutcome;
}

export interface ReviewFateAggregate {
  category: string;
  severity: string | null;
  accepted: number;
  dismissed: number;
  reedited: number;
  ignored: number;
  total: number;
}

export interface RecentDismissal {
  body: string;
  file_path: string;
  severity: string | null;
  kind: string;
}

export interface ReviewIntelPort<
  SessionKey extends string = string,
  RecordId extends string = string,
> {
  getContract(
    sessionKind: string,
    sessionId: SessionKey,
    sourceHash: string,
  ): Awaitable<string | null>;
  saveContract(input: {
    session_kind: string;
    session_id: SessionKey;
    source_hash: string;
    obligations_json: string;
    provider_id?: string | null;
    model_id?: string | null;
  }): Awaitable<void>;
  recordFate(input: ReviewFateInput<SessionKey, RecordId>): Awaitable<void>;
  aggregateFates(projectId?: number): Awaitable<ReviewFateAggregate[]>;
  recentDismissals(limit?: number, projectId?: number): Awaitable<RecentDismissal[]>;
}
