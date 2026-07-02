/**
 * DesignSystemStore — CRUD for design system sessions, versions and
 * components (migration 048).
 *
 * Dual-mode constructor (path | DB handle), same as ChromeServiceStore.
 *
 * Three logical entities:
 *   - **session**    → 1 per Design System Creator instance, joined to
 *                       a parent CompanySession.
 *   - **version**    → N per session. Records every bump (or skip)
 *                       attempt. `source_hash` enables skip-if-unchanged.
 *   - **component**  → N per published version. Atomic components
 *                       and page templates the package exposes.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

export type DsStack = 'react-ts' | 'vue-ts' | 'angular';
export type DsBumpHint = 'patch' | 'minor' | 'major';
export type DsBumpKind = 'initial' | 'patch' | 'minor' | 'major';
export type DsVersionStatus = 'draft' | 'building' | 'published' | 'failed' | 'skipped';
export type DsComponentKind = 'atom' | 'page-template';
/** 'company' = pipeline legado (read-only); 'studio' = sessão single sobre projeto-workspace. */
export type DsSessionKind = 'company' | 'studio';
/** Modo de design (mig 190): 'fidelity' = tema é fonte da verdade; 'creative' = inspiração. */
export type DsSessionMode = 'fidelity' | 'creative';

export interface DesignSystemSession {
  id: number;
  /** Legacy company pipeline parent. NULL for studio sessions. */
  company_session_id: number | null;
  /** Host workspace project. NULL for legacy company sessions. */
  project_id: number | null;
  kind: DsSessionKind;
  name: string;
  package_name: string;
  stack: DsStack;
  source_zip_hash: string | null;
  source_zip_path: string | null;
  next_bump_hint: DsBumpHint;
  mcp_server_config_id: string | null;
  mode: DsSessionMode;
  /** Estado da máquina de etapas (schema em @mcp/design-system/pipeline/stages). NULL = sem pipeline. */
  pipeline_json: string | null;
  created_at: string;
}

export interface DesignSystemVersion {
  id: number;
  ds_session_id: number;
  semver: string;
  bump_kind: DsBumpKind;
  is_auto_bump: boolean;
  status: DsVersionStatus;
  source_hash: string | null;
  tarball_path: string | null;
  manifest_json: string | null;
  mcp_manifest_json: string | null;
  docs_md: string | null;
  storybook_path: string | null;
  error: string | null;
  created_at: string;
  published_at: string | null;
}

export interface DesignSystemComponent {
  id: number;
  version_id: number;
  name: string;
  kind: DsComponentKind;
  props_schema_json: string | null;
  example_code: string | null;
  created_at: string;
}

export interface CreateDsSessionInput {
  company_session_id: number;
  name: string;
  package_name: string;
  stack: DsStack;
  source_zip_hash?: string | null;
  source_zip_path?: string | null;
}

export interface CreateDsStudioSessionInput {
  project_id: number;
  name: string;
  package_name: string;
  stack: DsStack;
  mode?: DsSessionMode;
  source_zip_hash?: string | null;
  source_zip_path?: string | null;
}

export interface CreateDsVersionInput {
  ds_session_id: number;
  semver: string;
  bump_kind: DsBumpKind;
  is_auto_bump?: boolean;
  status?: DsVersionStatus;
  source_hash?: string | null;
}

export interface UpdateDsVersionArtifacts {
  status?: DsVersionStatus;
  source_hash?: string | null;
  tarball_path?: string | null;
  manifest_json?: string | null;
  mcp_manifest_json?: string | null;
  docs_md?: string | null;
  storybook_path?: string | null;
  error?: string | null;
  markPublished?: boolean;
}

export interface CreateDsComponentInput {
  version_id: number;
  name: string;
  kind: DsComponentKind;
  props_schema_json?: string | null;
  example_code?: string | null;
}

interface SessionRow {
  id: number;
  company_session_id: number | null;
  project_id: number | null;
  kind: string;
  name: string;
  package_name: string;
  stack: string;
  source_zip_hash: string | null;
  source_zip_path: string | null;
  next_bump_hint: string;
  mcp_server_config_id: string | null;
  mode: string | null;
  pipeline_json: string | null;
  created_at: string;
}

interface VersionRow {
  id: number;
  ds_session_id: number;
  semver: string;
  bump_kind: string;
  is_auto_bump: number;
  status: string;
  source_hash: string | null;
  tarball_path: string | null;
  manifest_json: string | null;
  mcp_manifest_json: string | null;
  docs_md: string | null;
  storybook_path: string | null;
  error: string | null;
  created_at: string;
  published_at: string | null;
}

interface ComponentRow {
  id: number;
  version_id: number;
  name: string;
  kind: string;
  props_schema_json: string | null;
  example_code: string | null;
  created_at: string;
}

function hydrateSession(r: SessionRow): DesignSystemSession {
  return {
    id: r.id,
    company_session_id: r.company_session_id,
    project_id: r.project_id ?? null,
    kind: (r.kind as DsSessionKind) ?? 'company',
    name: r.name,
    package_name: r.package_name,
    stack: r.stack as DsStack,
    source_zip_hash: r.source_zip_hash,
    source_zip_path: r.source_zip_path,
    next_bump_hint: r.next_bump_hint as DsBumpHint,
    mcp_server_config_id: r.mcp_server_config_id ?? null,
    mode: r.mode === 'fidelity' ? 'fidelity' : 'creative',
    pipeline_json: r.pipeline_json ?? null,
    created_at: r.created_at,
  };
}

function hydrateVersion(r: VersionRow): DesignSystemVersion {
  return {
    id: r.id,
    ds_session_id: r.ds_session_id,
    semver: r.semver,
    bump_kind: r.bump_kind as DsBumpKind,
    is_auto_bump: !!r.is_auto_bump,
    status: r.status as DsVersionStatus,
    source_hash: r.source_hash,
    tarball_path: r.tarball_path,
    manifest_json: r.manifest_json,
    mcp_manifest_json: r.mcp_manifest_json,
    docs_md: r.docs_md,
    storybook_path: r.storybook_path,
    error: r.error,
    created_at: r.created_at,
    published_at: r.published_at,
  };
}

function hydrateComponent(r: ComponentRow): DesignSystemComponent {
  return {
    id: r.id,
    version_id: r.version_id,
    name: r.name,
    kind: r.kind as DsComponentKind,
    props_schema_json: r.props_schema_json,
    example_code: r.example_code,
    created_at: r.created_at,
  };
}

export class DesignSystemStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrHandle: string | DB) {
    if (typeof dbPathOrHandle === 'string') {
      this.db = new Database(dbPathOrHandle);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrHandle;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  // ── Sessions ──────────────────────────────────────────────────────

  /** @deprecated Company pipeline is retired — only kept for legacy data/tests. */
  createSession(input: CreateDsSessionInput): DesignSystemSession {
    const info = this.db
      .prepare(
        `INSERT INTO design_system_sessions
           (company_session_id, kind, name, package_name, stack, source_zip_hash, source_zip_path)
         VALUES (?, 'company', ?, ?, ?, ?, ?)`,
      )
      .run(
        input.company_session_id,
        input.name,
        input.package_name,
        input.stack,
        input.source_zip_hash ?? null,
        input.source_zip_path ?? null,
      );
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  createStudioSession(input: CreateDsStudioSessionInput): DesignSystemSession {
    const info = this.db
      .prepare(
        `INSERT INTO design_system_sessions
           (project_id, kind, name, package_name, stack, mode, source_zip_hash, source_zip_path)
         VALUES (?, 'studio', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.project_id,
        input.name,
        input.package_name,
        input.stack,
        input.mode ?? 'creative',
        input.source_zip_hash ?? null,
        input.source_zip_path ?? null,
      );
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  /** Estado da máquina de etapas (pipeline_json, mig 190). */
  setPipelineJson(sessionId: number, json: string | null): DesignSystemSession {
    this.db
      .prepare('UPDATE design_system_sessions SET pipeline_json = ? WHERE id = ?')
      .run(json, sessionId);
    return this.getSession(sessionId)!;
  }

  getSession(id: number): DesignSystemSession | null {
    const row = this.db
      .prepare('SELECT * FROM design_system_sessions WHERE id = ?')
      .get(id) as SessionRow | undefined;
    return row ? hydrateSession(row) : null;
  }

  getSessionByCompanySessionId(companySessionId: number): DesignSystemSession | null {
    const row = this.db
      .prepare('SELECT * FROM design_system_sessions WHERE company_session_id = ?')
      .get(companySessionId) as SessionRow | undefined;
    return row ? hydrateSession(row) : null;
  }

  getSessionByProjectId(projectId: number): DesignSystemSession | null {
    const row = this.db
      .prepare('SELECT * FROM design_system_sessions WHERE project_id = ?')
      .get(projectId) as SessionRow | undefined;
    return row ? hydrateSession(row) : null;
  }

  listSessions(): DesignSystemSession[] {
    const rows = this.db
      .prepare('SELECT * FROM design_system_sessions ORDER BY created_at DESC')
      .all() as SessionRow[];
    return rows.map(hydrateSession);
  }

  setNextBumpHint(sessionId: number, hint: DsBumpHint): DesignSystemSession {
    this.db
      .prepare('UPDATE design_system_sessions SET next_bump_hint = ? WHERE id = ?')
      .run(hint, sessionId);
    return this.getSession(sessionId)!;
  }

  setMcpServerConfigId(sessionId: number, configId: string | null): DesignSystemSession {
    this.db
      .prepare('UPDATE design_system_sessions SET mcp_server_config_id = ? WHERE id = ?')
      .run(configId, sessionId);
    return this.getSession(sessionId)!;
  }

  deleteSession(id: number): void {
    this.db.prepare('DELETE FROM design_system_sessions WHERE id = ?').run(id);
  }

  // ── Versions ──────────────────────────────────────────────────────

  createVersion(input: CreateDsVersionInput): DesignSystemVersion {
    const info = this.db
      .prepare(
        `INSERT INTO design_system_versions
           (ds_session_id, semver, bump_kind, is_auto_bump, status, source_hash)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.ds_session_id,
        input.semver,
        input.bump_kind,
        input.is_auto_bump ? 1 : 0,
        input.status ?? 'draft',
        input.source_hash ?? null,
      );
    return this.getVersion(Number(info.lastInsertRowid))!;
  }

  getVersion(id: number): DesignSystemVersion | null {
    const row = this.db
      .prepare('SELECT * FROM design_system_versions WHERE id = ?')
      .get(id) as VersionRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  getVersionBySemver(sessionId: number, semver: string): DesignSystemVersion | null {
    const row = this.db
      .prepare(
        'SELECT * FROM design_system_versions WHERE ds_session_id = ? AND semver = ?',
      )
      .get(sessionId, semver) as VersionRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  /** Most recent published version (for semver bump computation). */
  getLatestPublishedVersion(sessionId: number): DesignSystemVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM design_system_versions
         WHERE ds_session_id = ? AND status = 'published'
         ORDER BY published_at DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as VersionRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  /** Most recent version regardless of status. */
  getLatestVersionAny(sessionId: number): DesignSystemVersion | null {
    const row = this.db
      .prepare(
        `SELECT * FROM design_system_versions
         WHERE ds_session_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as VersionRow | undefined;
    return row ? hydrateVersion(row) : null;
  }

  listVersions(sessionId: number): DesignSystemVersion[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM design_system_versions WHERE ds_session_id = ? ORDER BY created_at DESC',
      )
      .all(sessionId) as VersionRow[];
    return rows.map(hydrateVersion);
  }

  updateVersion(id: number, patch: UpdateDsVersionArtifacts): DesignSystemVersion {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];

    const setIfPresent = (key: keyof UpdateDsVersionArtifacts, col: string) => {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        sets.push(`${col} = ?`);
        params.push((patch[key] as string | null | undefined) ?? null);
      }
    };

    setIfPresent('status', 'status');
    setIfPresent('source_hash', 'source_hash');
    setIfPresent('tarball_path', 'tarball_path');
    setIfPresent('manifest_json', 'manifest_json');
    setIfPresent('mcp_manifest_json', 'mcp_manifest_json');
    setIfPresent('docs_md', 'docs_md');
    setIfPresent('storybook_path', 'storybook_path');
    setIfPresent('error', 'error');

    if (patch.markPublished) {
      sets.push("published_at = datetime('now')");
      if (!sets.some((s) => s.startsWith('status'))) {
        sets.push("status = 'published'");
      }
    }

    if (sets.length === 0) return this.getVersion(id)!;
    this.db
      .prepare(`UPDATE design_system_versions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
    return this.getVersion(id)!;
  }

  // ── Components ────────────────────────────────────────────────────

  createComponent(input: CreateDsComponentInput): DesignSystemComponent {
    const info = this.db
      .prepare(
        `INSERT INTO design_system_components
           (version_id, name, kind, props_schema_json, example_code)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        input.version_id,
        input.name,
        input.kind,
        input.props_schema_json ?? null,
        input.example_code ?? null,
      );
    return this.getComponent(Number(info.lastInsertRowid))!;
  }

  getComponent(id: number): DesignSystemComponent | null {
    const row = this.db
      .prepare('SELECT * FROM design_system_components WHERE id = ?')
      .get(id) as ComponentRow | undefined;
    return row ? hydrateComponent(row) : null;
  }

  listComponents(versionId: number): DesignSystemComponent[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM design_system_components WHERE version_id = ? ORDER BY kind, name',
      )
      .all(versionId) as ComponentRow[];
    return rows.map(hydrateComponent);
  }

  getComponentByName(versionId: number, name: string): DesignSystemComponent | null {
    const row = this.db
      .prepare(
        'SELECT * FROM design_system_components WHERE version_id = ? AND name = ?',
      )
      .get(versionId, name) as ComponentRow | undefined;
    return row ? hydrateComponent(row) : null;
  }
}
