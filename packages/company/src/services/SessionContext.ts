/**
 * SessionContext — shared state and dependencies passed to every service.
 *
 * Keeps the "common" surface (store, DB, bus, abort state) in one place so
 * individual services don't need to duplicate constructor parameters.
 * Services receive this plus any narrow peer ports they need.
 */

import type { CompanyStore } from '@mcp/store/company-store.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import {
  asCompanySessionId,
  type CompanySessionId,
} from '@mcp/session-storage';
import type {
  CompanyRuntimeKind,
  CompanySessionCapabilities,
  CompanySessionProject,
} from '@mcp/company/types.js';
import type { CoderRunBus } from '@apps/http-api/coder-bus.js';
import { resolveCompanySessionCapabilities } from '@mcp/company/services/session-capabilities.js';
import type { CompanySessionFiles } from '@mcp/company/services/CompanySessionFiles.js';
import { CompanyWorkspaceCoordinator } from './workspace-coordinator.js';
import { CompanySessionMessenger } from './session-messenger.js';

export interface SessionContextOpts {
  companySessionId: CompanySessionId | string;
  companyFiles: CompanySessionFiles;
  /**
   * Filesystem authority for project-wide Company entities. Child sessions
   * keep their board/inbox/agent-run records in `companyFiles`, while Kanban
   * and the other shared surfaces live in the root bundle.
   */
  effectiveCompanyFiles?: CompanySessionFiles;
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
  parentSessionId?: CompanySessionId | string | null;
  runtimeKind?: CompanyRuntimeKind;
  appStudioSessionId?: string | null;
  capabilities?: CompanySessionCapabilities;
}

export class SessionContext {
  readonly companySessionId: CompanySessionId;
  readonly companyFiles: CompanySessionFiles;
  readonly effectiveCompanyFiles: CompanySessionFiles;
  private workspaceCoordinator: CompanyWorkspaceCoordinator | undefined;
  get workspaceMutationGate(): CompanyWorkspaceCoordinator {
    return this.workspaceCoordinator ??= new CompanyWorkspaceCoordinator(this.effectiveCompanyFiles.location.bundle_path);
  }
  private messenger: CompanySessionMessenger | undefined;
  get sessionMessenger(): CompanySessionMessenger { return this.messenger ??= new CompanySessionMessenger(this.companyFiles); }
  readonly companyStore: CompanyStore;
  readonly db: CodeIndexDB;
  readonly metaBus: CoderRunBus;
  readonly parentSessionId: CompanySessionId | null;
  readonly runtimeKind: CompanyRuntimeKind;
  readonly appStudioSessionId: string | null;
  readonly capabilities: CompanySessionCapabilities;

  private _aborted = false;
  private _finalized = false;
  private _projects: CompanySessionProject[];

  constructor(opts: SessionContextOpts) {
    this.companySessionId = asCompanySessionId(String(opts.companySessionId));
    this.companyFiles = opts.companyFiles;
    this.effectiveCompanyFiles =
      opts.effectiveCompanyFiles ?? opts.companyFiles;
    this.companyStore = opts.companyStore;
    this.db = opts.db;
    this.metaBus = opts.metaBus;
    this.parentSessionId = opts.parentSessionId == null
      ? null
      : asCompanySessionId(String(opts.parentSessionId));
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
    const session = this.companyFiles.getSession();
    return session.project_ids.map((projectId) => ({
      company_session_id: this.companySessionId,
      project_id: projectId,
      label: session.project_labels[String(projectId)] ?? null,
    }));
  }

  get projects(): ReadonlyArray<CompanySessionProject> {
    return this._projects;
  }

  /**
   * Effective company_session_id for **shared** project-wide artefacts:
   * kanban, env, services management, databases, docs,
   * drive (the drive store has its own resolution but
   * uses the same logic). For sub-sessions (`parent_session_id != null`)
   * this returns the parent's id so every tab of the same root reads
   * and writes to the same parent-bundle entities.
   *
   * Per-tab data — board, agent runs, master prompts and inbox — keeps using
   * `companySessionId` directly. Those entities remain in the child bundle so
   * each tab's master, subordinates, board and questions stay independent.
   */
  get effectiveSessionId(): CompanySessionId {
    return this.parentSessionId ?? this.companySessionId;
  }

  get isAborted(): boolean {
    return this._aborted;
  }

  get isBusEnded(): boolean {
    return this.metaBus.ended;
  }

  get isFinalized(): boolean {
    return this._finalized;
  }

  markAborted(): void {
    this._aborted = true;
  }

  markFinalized(): void {
    this._finalized = true;
  }

  /** Re-read projects from the DB (e.g., after an admin modified links). */
  refreshProjects(): void {
    this._projects = this.loadProjects();
  }
}
