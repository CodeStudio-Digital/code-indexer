import type { AuditEvent, AuditEventKind } from '../domain/audit-event.js';

export interface AuditLogQuery {
  since?: number;
  until?: number;
  principal?: string;
  event?: AuditEventKind;
  limit?: number;
}

export interface AuditLogRepo {
  record(event: AuditEvent): void;
  query(filter: AuditLogQuery): AuditEvent[];
  purgeBefore(at: number): void;
}
