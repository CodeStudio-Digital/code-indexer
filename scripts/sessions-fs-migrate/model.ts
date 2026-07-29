import type DatabaseConstructor from 'better-sqlite3';

export const SESSION_LAYOUT_VERSION = 1;
export const MIGRATION_FORMAT_VERSION = 1;

export type MigrationMode = 'dry-run' | 'apply' | 'verify-only';
export type LegacyEntityKind =
  | 'coder'
  | 'company'
  | 'app_studio'
  | 'sprite'
  | 'design'
  | 'docs'
  | 'mcp_run';
export type SessionStorageScope = 'project' | 'global';

export interface CliOptions {
  mode: MigrationMode;
  deleteSourceDb: boolean;
  dbPath?: string;
  dataDir?: string;
  json: boolean;
}

export type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export interface ProjectRow {
  id: number;
  root_path: string;
  name?: string | null;
  is_synthetic?: number;
  db_path?: string | null;
  db_split_status?: string | null;
}

export interface LegacyIdentity {
  kind: LegacyEntityKind;
  id: number | string;
}

export interface UuidMapFile {
  format_version: number;
  source_db_fingerprint: string;
  created_at: string;
  identities: Record<string, string>;
}

export interface MigrationFile {
  format_version: number;
  layout_version: number;
  source_db_fingerprint: string;
  legacy: LegacyIdentity;
  session_uuid: string;
  phase: 'staging' | 'committed';
  created_at: string;
  committed_at?: string;
  counts: Record<string, number>;
  hashes: Record<string, string>;
  unavailable_artifacts: Array<{
    kind: 'legacy_artifact_unavailable';
    legacy_ref: string;
    reason: string;
  }>;
}

export interface BundlePlan {
  identity: LegacyIdentity;
  uuid: string;
  scope: SessionStorageScope;
  projectRoot?: string;
  finalDir: string;
  stagingDir: string;
}

export interface SourceInventory {
  dbPath: string;
  dbFingerprint: string;
  dbBytes: number;
  projects: ProjectRow[];
  tables: Record<string, {
    disposition: 'drop' | 'delete_rows' | 'keep';
    rows: number;
    sql?: string | null;
  }>;
  coderSessionIds: number[];
  companySessionIds: number[];
  appStudioSessionIds: Array<number | string>;
  spriteProjectIds: number[];
  requiredBytes: number;
}

export interface MigrationRunState {
  format_version: number;
  source_db_path: string;
  source_db_fingerprint: string;
  source_db_bytes: number;
  phase:
    | 'inventoried'
    | 'exporting'
    | 'exported'
    | 'clean_clone_verified'
    | 'db_swapped'
    | 'verified'
    | 'complete';
  started_at: string;
  updated_at: string;
  clean_clone_path?: string;
  old_db_path?: string;
  expected_counts: Record<string, number>;
  exported_counts: Record<string, number>;
  legacy_orphan_cleanup: Record<string, LegacyOrphanCleanupAudit>;
  roots: string[];
}

export interface LegacyOrphanCleanupAudit {
  rows: number;
  content_bytes: number;
  sha256: string;
  external_bytes?: number;
}

export interface ArtifactRef {
  type: 'artifact_ref';
  artifact_kind: 'attachment' | 'tool_output' | 'snapshot' | 'legacy_side_file';
  relative_path: string;
  sha256: string;
  size_bytes: number;
  mime_type?: string;
}

export interface UnavailableArtifactRef {
  type: 'legacy_artifact_unavailable';
  legacy_ref: string;
  reason: string;
}

export type MigratedArtifactRef = ArtifactRef | UnavailableArtifactRef;

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export function legacyIdentityKey(identity: LegacyIdentity): string {
  return `${identity.kind}:${identity.id}`;
}
