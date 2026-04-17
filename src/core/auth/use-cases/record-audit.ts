import type { AuditEvent } from '../domain/audit-event.js';
import type { AuditLogRepo } from '../ports/audit-log-repository.js';
import type { Clock } from '../ports/clock.js';

export class RecordAudit {
  constructor(
    private readonly repo: AuditLogRepo,
    private readonly clock: Clock,
  ) {}

  execute(partial: Omit<AuditEvent, 'at'>): void {
    this.repo.record({ ...partial, at: this.clock.now() });
  }
}
