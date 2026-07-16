/**
 * SessionContext — shared state and dependencies passed to every service.
 *
 * Keeps the "common" surface (store, DB, bus, abort state) in one place so
 * individual services don't need to duplicate constructor parameters.
 * Services receive this plus any narrow peer ports they need.
 */

import type { CompanyStore } from '@mcp/store/company-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
  CompanySessionProject,
} from '@mcp/company/types.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';

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
  runtimeKind?: CompanyRuntimeKind;
  appStudioSessionId?: number | null;
  capabilities?: CompanySessionCapabilities;
}

export class SessionContext {
  readonly companySessionId: number;
  readonly companyStore: CompanyStore;
  readonly db: CodeIndexDB;
  readonly metaBus: CoderRunBus;
  readonly parentSessionId: number | null;
  readonly runtimeKind: CompanyRuntimeKind;
  readonly appStudioSessionId: number | null;
  readonly capabilities: CompanySessionCapabilities;

  private _aborted = false;
  private _projects: CompanySessionProject[];

  constructor(opts: SessionContextOpts) {
    this.companySessionId = opts.companySessionId;
    this.companyStore = opts.companyStore;
    this.db = opts.db;
    this.metaBus = opts.metaBus;
    this.parentSessionId = opts.parentSessionId ?? null;
    this.capabilities = opts.capabilities ?? resolveCompanySessionCapabilities(
      opts.runtimeKind ?? 'company',
      opts.appStudioSessionId ?? null,
    );
    this.runtimeKind = this.capabilities.runtimeKind;
    this.appStudioSessionId = this.capabilities.appStudioSessionId;
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

  /**
   * Effective company_session_id for **shared** project-wide artefacts:
   * kanban, pipelines, env, services management, databases, docs,
   * design-system, drive (the drive store has its own resolution but
   * uses the same logic). For sub-sessions (`parent_session_id != null`)
   * this returns the parent's id so every tab of the same root reads
   * and writes to the same project-level rows.
   *
   * Per-tab data — `company_board`, `company_agent_runs`,
   * `company_master_prompts`, `agent_inbox` — keeps using
   * `companySessionId` directly. Those are isolated by FK on purpose so
   * each tab's master / subs / board / questions stay independent.
   */
  get effectiveSessionId(): number {
    return this.parentSessionId ?? this.companySessionId;
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
