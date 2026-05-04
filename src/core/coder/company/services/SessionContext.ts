/**
 * SessionContext — shared state and dependencies passed to every service.
 *
 * Keeps the "common" surface (store, DB, bus, abort state) in one place so
 * individual services don't need to duplicate constructor parameters.
 * Services receive this plus any narrow peer ports they need.
 */

import type { CompanyStore } from '../../../../store/company-store.js';
import type { CodeIndexDB } from '../../../../store/db.js';
import type { CompanySessionProject } from '../types.js';
import type { CoderRunBus } from '../../../../apps/http-api/coder-bus.js';

export interface SessionContextOpts {
  companySessionId: number;
  companyStore: CompanyStore;
  db: CodeIndexDB;
  metaBus: CoderRunBus;
  /**
   * Migration 067: when this session is a sub-session, project links
   * fall back to the parent's `company_session_projects` so all tabs of
   * the same root see the same project list. Read once at construction
   * (also re-read by `refreshProjects`) — no live link to parent's DB
   * mutations beyond the explicit refresh.
   */
  parentSessionId?: number | null;
}

export class SessionContext {
  readonly companySessionId: number;
  readonly companyStore: CompanyStore;
  readonly db: CodeIndexDB;
  readonly metaBus: CoderRunBus;
  readonly parentSessionId: number | null;

  private _aborted = false;
  private _projects: CompanySessionProject[];

  constructor(opts: SessionContextOpts) {
    this.companySessionId = opts.companySessionId;
    this.companyStore = opts.companyStore;
    this.db = opts.db;
    this.metaBus = opts.metaBus;
    this.parentSessionId = opts.parentSessionId ?? null;
    this._projects = this.loadProjects();
  }

  /** Own projects first; if empty AND child, fall back to parent's. */
  private loadProjects(): CompanySessionProject[] {
    const own = this.companyStore.listCompanySessionProjects(this.companySessionId);
    if (own.length > 0 || this.parentSessionId == null) return own;
    return this.companyStore.listCompanySessionProjects(this.parentSessionId);
  }

  get projects(): ReadonlyArray<CompanySessionProject> {
    return this._projects;
  }

  get isAborted(): boolean {
    return this._aborted;
  }

  get isBusEnded(): boolean {
    return this.metaBus.ended;
  }

  markAborted(): void {
    this._aborted = true;
  }

  /** Re-read projects from the DB (e.g., after an admin modified links). */
  refreshProjects(): void {
    this._projects = this.loadProjects();
  }
}
