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
}

export class SessionContext {
  readonly companySessionId: number;
  readonly companyStore: CompanyStore;
  readonly db: CodeIndexDB;
  readonly metaBus: CoderRunBus;

  private _aborted = false;
  private _projects: CompanySessionProject[];

  constructor(opts: SessionContextOpts) {
    this.companySessionId = opts.companySessionId;
    this.companyStore = opts.companyStore;
    this.db = opts.db;
    this.metaBus = opts.metaBus;
    this._projects = opts.companyStore.listCompanySessionProjects(opts.companySessionId);
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
    this._projects = this.companyStore.listCompanySessionProjects(this.companySessionId);
  }
}
