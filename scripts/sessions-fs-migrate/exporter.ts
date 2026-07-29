import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
} from 'node:path';
import type {
  BundlePlan,
  Logger,
  MigrationFile,
  MigrationRunState,
  ProjectRow,
  SqliteDatabase,
} from './model.js';
import {
  MIGRATION_FORMAT_VERSION,
  SESSION_LAYOUT_VERSION,
} from './model.js';
import {
  ArtifactStore,
  asSessionId,
  canonicalJson,
  type ArtifactRef,
  type ConversationCommit,
  type JsonValue,
  type SessionMetadata,
  type SessionState,
} from './session-storage-adapter.js';
import {
  atomicWriteFile,
  atomicWriteJson,
  fileHash,
  sha256Bytes,
} from './fs-ops.js';
import type {
  MigratedRowStub,
  RelationalExportIndex,
} from './relational.js';
import { tableColumns, tableExists } from './db.js';
import type { SecretSealer } from './secrets.js';
import { protectSecretPath, sealCompanyEnvironmentRow } from './secrets.js';
import { legacySandboxArchiveDir } from './legacy-paths.js';

export interface ExportContext {
  db: SqliteDatabase;
  dataDir: string;
  sourceFingerprint: string;
  projects: readonly ProjectRow[];
  relational: RelationalExportIndex;
  sealer: SecretSealer;
  logger: Logger;
  runState: MigrationRunState;
}

interface ToolReference {
  callId: string;
  toolCallId: string;
  messageId: string | null;
  toolName: string;
  args: JsonValue;
  isError: boolean;
  durationMs: number;
  nested: boolean;
  output: {
    schema_version: 1;
    id: string;
    call_id: string;
    created_at: string;
    raw: ArtifactRef | null;
    shaped: ArtifactRef | null;
    metadata: Record<string, JsonValue>;
  };
  metadata: Record<string, JsonValue>;
  artifacts: ArtifactRef[];
}

interface BundleExportStats {
  counts: Record<string, number>;
  hashes: Record<string, string>;
  unavailable: MigrationFile['unavailable_artifacts'];
  turnCount: number;
  metricToolCalls: number;
  metricUsage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
  };
}

export interface LegacyConversationMessage<T = unknown> {
  id: string;
  role: unknown;
  isMeta: boolean;
  runId: string | null;
  createdAt: string | null;
  value: T;
}

export interface LegacyTurnGroup<T = unknown> {
  kind: 'legacy_preamble' | 'turn';
  messages: Array<LegacyConversationMessage<T>>;
}

/**
 * The filesystem journal commits complete turns, never individual messages.
 * A visible user message is the authoritative legacy turn boundary. Messages
 * before the first such boundary are retained, in order, in one explicit
 * preamble commit. `run_id` is preserved on each message but is not a reliable
 * boundary in older databases where the column did not exist.
 */
export function groupLegacyMessagesIntoTurns<T>(
  messages: readonly LegacyConversationMessage<T>[],
): Array<LegacyTurnGroup<T>> {
  const groups: Array<LegacyTurnGroup<T>> = [];
  let current: LegacyTurnGroup<T> | null = null;
  let sawVisibleUser = false;

  const flush = (): void => {
    if (current && current.messages.length > 0) groups.push(current);
    current = null;
  };

  for (const message of messages) {
    const startsTurn = message.role === 'user' && !message.isMeta;
    if (startsTurn) {
      flush();
      sawVisibleUser = true;
      current = { kind: 'turn', messages: [] };
    } else if (!current) {
      current = {
        kind: sawVisibleUser ? 'turn' : 'legacy_preamble',
        messages: [],
      };
    }
    current.messages.push(message);
  }
  flush();
  return groups;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function bool(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function nonNegativeInteger(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : 0;
}

function positiveInteger(value: unknown, label: string): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return numeric;
}

function migratedReference(
  ctx: ExportContext,
  table: string,
  value: unknown,
  label: string,
): string | null {
  if (value == null) return null;
  const uuid = ctx.relational.uuidForReference(table, 'id', value);
  if (!uuid) {
    throw new Error(`Cannot remap ${label}=${String(value)} from ${table}`);
  }
  return uuid;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function deterministicUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '5';
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join('-');
}

function normalizedUuid(value: unknown, fallbackSeed: string): string {
  if (
    typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    return value.toLowerCase();
  }
  return deterministicUuid(fallbackSeed);
}

function jsonText(value: unknown, fallback: JsonValue): string {
  const parsed = value == null || value === '' ? fallback : parseJson(value);
  return typeof parsed === 'string' && parsed === value
    ? JSON.stringify(fallback)
    : JSON.stringify(parsed);
}

function toolOutputRecordFileName(callId: string): string {
  return `${createHash('sha256').update(callId, 'utf8').digest('hex')}.json`;
}

function normalizeStatus(value: unknown): unknown {
  return value === 'running' || value === 'starting' || value === 'queued'
    ? 'interrupted'
    : value;
}

function normalizeInterrupted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeInterrupted);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = key === 'status' ? normalizeStatus(child) : normalizeInterrupted(child);
  }
  return output;
}

function mimeExtension(mime: string | undefined): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
  };
  return mime ? known[mime.toLowerCase()] ?? '' : '';
}

function dataUri(value: string): { mime: string; bytes: Buffer } | null {
  const match = /^data:([^;,]+)?;base64,([a-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) return null;
  try {
    return {
      mime: match[1] || 'application/octet-stream',
      bytes: Buffer.from(match[2].replace(/\s/g, ''), 'base64'),
    };
  } catch {
    return null;
  }
}

async function extractInlineArtifacts(
  value: unknown,
  store: ArtifactStore,
  refs: ArtifactRef[],
): Promise<unknown> {
  if (typeof value === 'string') {
    const decoded = dataUri(value);
    if (!decoded) return value;
    const ref = await store.put({
      kind: 'attachment',
      data: decoded.bytes,
      media_type: decoded.mime,
      logical_name: `inline-${sha256Bytes(decoded.bytes).slice(0, 12)}${mimeExtension(decoded.mime)}`,
    });
    refs.push(ref);
    return {
      type: 'artifact_ref',
      source_type: decoded.mime.startsWith('image/') ? 'image' : 'document',
      encoding: 'base64',
      artifact: ref,
      media_type: decoded.mime,
    };
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) output.push(await extractInlineArtifacts(item, store, refs));
    return output;
  }
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  const source =
    input.source != null &&
    typeof input.source === 'object' &&
    !Array.isArray(input.source)
      ? (input.source as Record<string, unknown>)
      : null;
  const directBase64 =
    typeof input.base64 === 'string'
      ? input.base64
      : source?.type === 'base64' && typeof source.data === 'string'
        ? source.data
        : null;
  if (
    (input.type === 'image' || input.type === 'document') &&
    directBase64
  ) {
    const mime =
      text(input.mediaType) ??
      text(input.media_type) ??
      text(source?.media_type) ??
      'application/octet-stream';
    const bytes = Buffer.from(directBase64, 'base64');
    const ref = await store.put({
      kind: 'attachment',
      data: bytes,
      media_type: mime,
      logical_name:
        text(input.name) ??
        `inline-${sha256Bytes(bytes).slice(0, 12)}${mimeExtension(mime)}`,
    });
    refs.push(ref);
    return {
      type: 'artifact_ref',
      source_type: input.type,
      encoding: 'base64',
      artifact: ref,
      media_type: mime,
      ...(text(input.name) ? { name: text(input.name) } : {}),
      ...(text(input.path) ? { path: text(input.path) } : {}),
      ...(text(input.describeHint)
        ? { describe_hint: text(input.describeHint) }
        : {}),
    };
  }
  if (
    input.type === 'document' &&
    typeof input.text === 'string'
  ) {
    const mime = text(input.mediaType) ?? text(input.media_type) ?? 'text/plain';
    const ref = await store.put({
      kind: 'attachment',
      data: input.text,
      media_type: mime,
      logical_name: text(input.name) ?? 'document.txt',
    });
    refs.push(ref);
    return {
      type: 'artifact_ref',
      source_type: 'document',
      encoding: 'utf8',
      artifact: ref,
      media_type: mime,
      ...(text(input.name) ? { name: text(input.name) } : {}),
      ...(text(input.path) ? { path: text(input.path) } : {}),
    };
  }
  if (
    input.type === 'base64'
    && typeof input.data === 'string'
    && input.data.length > 0
  ) {
    const mime = typeof input.media_type === 'string'
      ? input.media_type
      : typeof input.mime_type === 'string'
        ? input.mime_type
        : 'application/octet-stream';
    let bytes: Buffer;
    try {
      bytes = Buffer.from(input.data, 'base64');
    } catch {
      return value;
    }
    const ref = await store.put({
      kind: 'attachment',
      data: bytes,
      media_type: mime,
      logical_name: `inline-${sha256Bytes(bytes).slice(0, 12)}${mimeExtension(mime)}`,
    });
    refs.push(ref);
    return {
      type: 'artifact_ref',
      source_type: mime.startsWith('image/') ? 'image' : 'document',
      encoding: 'base64',
      artifact: ref,
      media_type: mime,
    };
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(input)) {
    output[key] = await extractInlineArtifacts(child, store, refs);
  }
  return output;
}

function replaceToolResults(
  value: unknown,
  toolRefs: ReadonlyMap<string, ToolReference>,
  artifacts: ArtifactRef[],
): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceToolResults(item, toolRefs, artifacts));
  if (!value || typeof value !== 'object') return value;
  const input = value as Record<string, unknown>;
  if (input.type === 'tool_result' && typeof input.tool_use_id === 'string') {
    const ref = toolRefs.get(input.tool_use_id);
    if (ref) {
      artifacts.push(...ref.artifacts);
      const { content: _removed, ...rest } = input;
      return {
        ...rest,
        type: 'tool_result_ref',
        output: ref.output,
        is_error: ref.isError,
      };
    }
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, child]) => [key, replaceToolResults(child, toolRefs, artifacts)]),
  );
}

function dedupeArtifacts(refs: readonly ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.sha256}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function messageRole(value: unknown): 'system' | 'user' | 'assistant' | 'tool' {
  return value === 'system' ||
    value === 'user' ||
    value === 'assistant' ||
    value === 'tool'
    ? value
    : 'system';
}

function messageContent(value: unknown): JsonValue[] {
  if (Array.isArray(value)) return value as JsonValue[];
  if (value == null) return [];
  if (typeof value === 'string') {
    return [{ type: 'text', text: value }];
  }
  if (typeof value === 'object') return [value as JsonValue];
  return [{ type: 'text', text: String(value) }];
}

function stringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

function goalMutation(
  sessionUuid: string,
  root: Record<string, unknown>,
): JsonValue[] {
  const goalText = text(root.goal_text);
  if (!goalText) return [];
  const createdAt =
    text(root.goal_created_at) ??
    text(root.created_at) ??
    new Date().toISOString();
  const updatedAt =
    text(root.goal_updated_at) ??
    text(root.updated_at) ??
    createdAt;
  const legacyStatus = text(root.goal_status);
  const status =
    legacyStatus === 'complete' || legacyStatus === 'superseded'
      ? legacyStatus
      : 'in_progress';
  const completionNote = text(root.goal_completion_note);
  return [
    {
      id: deterministicUuid(`goal-mutation:${sessionUuid}:1`),
      seq: 1,
      source: 'admin',
      tool_use_id: null,
      tool_name: null,
      expected: null,
      next: {
        id: deterministicUuid(`goal:${sessionUuid}`),
        text: goalText,
        status,
        budget_tokens:
          typeof root.goal_budget_tokens === 'number'
            ? root.goal_budget_tokens
            : null,
        completion_note: completionNote,
        created_at: createdAt,
        updated_at: updatedAt,
      },
    },
  ];
}

function fullRow(db: SqliteDatabase, stub: MigratedRowStub): Record<string, unknown> {
  return db.prepare(
    `SELECT rowid AS __rowid, * FROM "${stub.table}" WHERE rowid = ?`,
  ).get(stub.legacyRowId) as Record<string, unknown>;
}

function rowsForPlan(
  relational: RelationalExportIndex,
  plan: BundlePlan,
  table: string,
): MigratedRowStub[] {
  return (relational.rowsByTable.get(table) ?? []).filter((row) => row.owner.uuid === plan.uuid);
}

function rootTable(plan: BundlePlan): string {
  switch (plan.identity.kind) {
    case 'coder': return 'coder_sessions';
    case 'company': return 'company_sessions';
    case 'app_studio': return 'app_studio_sessions';
    case 'sprite': return 'sprite_projects';
    case 'design': return 'design_system_sessions';
    case 'docs': return 'docs_research_sessions';
    case 'mcp_run': return 'mcp_agent_runs';
  }
}

function rootStub(ctx: ExportContext, plan: BundlePlan): MigratedRowStub {
  const table = rootTable(plan);
  const row = (ctx.relational.rowsByTable.get(table) ?? []).find(
    (candidate) => candidate.entityUuid === plan.uuid,
  );
  if (!row) throw new Error(`missing root row for ${plan.identity.kind}:${plan.identity.id}`);
  return row;
}

function linkedProjects(
  db: SqliteDatabase,
  plan: BundlePlan,
  root: Record<string, unknown>,
  projects: readonly ProjectRow[],
): Array<{ project_id: number; root_path: string }> {
  if (
    plan.identity.kind === 'design'
    && typeof root.company_session_id === 'number'
    && tableExists(db, 'company_sessions')
  ) {
    const companyRoot = db.prepare(
      `SELECT * FROM company_sessions WHERE id = ?`,
    ).get(root.company_session_id) as Record<string, unknown> | undefined;
    if (!companyRoot) {
      throw new Error(
        `Design session ${String(plan.identity.id)} references missing Company session ${root.company_session_id}`,
      );
    }
    return linkedProjects(
      db,
      {
        ...plan,
        identity: { kind: 'company', id: root.company_session_id },
      },
      companyRoot,
      projects,
    );
  }
  const projectMap = new Map(
    projects.filter((project) => !project.is_synthetic).map((project) => [Number(project.id), project]),
  );
  const ids = new Set<number>();
  if (typeof root.project_id === 'number') ids.add(root.project_id);
  const junction = plan.identity.kind === 'coder'
    ? { table: 'coder_session_projects', column: 'coder_session_id' }
    : plan.identity.kind === 'company'
      ? { table: 'company_session_projects', column: 'company_session_id' }
      : null;
  if (junction && tableExists(db, junction.table)) {
    const rows = db.prepare(
      `SELECT project_id FROM "${junction.table}" WHERE "${junction.column}" = ? ORDER BY project_id`,
    ).all(plan.identity.id) as Array<{ project_id: number }>;
    for (const row of rows) ids.add(Number(row.project_id));
  }
  if (
    ids.size === 0
    && plan.identity.kind === 'company'
    && typeof root.master_session_id === 'number'
  ) {
    if (tableExists(db, 'coder_session_projects')) {
      const rows = db.prepare(
        `SELECT project_id FROM coder_session_projects
         WHERE coder_session_id = ? ORDER BY project_id`,
      ).all(root.master_session_id) as Array<{ project_id: number }>;
      for (const row of rows) ids.add(Number(row.project_id));
    }
    if (
      ids.size === 0
      && tableExists(db, 'coder_sessions')
      && tableColumns(db, 'coder_sessions').includes('project_id')
    ) {
      const coder = db.prepare(
        `SELECT project_id FROM coder_sessions WHERE id = ?`,
      ).get(root.master_session_id) as { project_id?: number } | undefined;
      if (typeof coder?.project_id === 'number') ids.add(coder.project_id);
    }
  }
  return [...ids].flatMap((id) => {
    const project = projectMap.get(id);
    if (!project) return [];
    return [{ project_id: id, root_path: project.root_path }];
  });
}

function parentSessionUuid(
  ctx: ExportContext,
  plan: BundlePlan,
  root: Record<string, unknown>,
): string | null {
  if (
    plan.identity.kind === 'design'
    && root.company_session_id != null
  ) {
    const parent = ctx.relational.uuidForReference(
      'company_sessions',
      'id',
      root.company_session_id,
    );
    if (!parent) {
      throw new Error(
        `Design session ${String(plan.identity.id)} has no migrated Company parent`,
      );
    }
    return parent;
  }
  const parent = root.parent_session_id;
  if (parent == null) return null;
  const kind = plan.identity.kind === 'company' ? 'company_sessions' : 'coder_sessions';
  return ctx.relational.uuidForReference(kind, 'id', parent) ?? null;
}

function createMetadata(
  ctx: ExportContext,
  plan: BundlePlan,
  root: Record<string, unknown>,
): SessionMetadata {
  const links = linkedProjects(ctx.db, plan, root, ctx.projects);
  const created = text(root.created_at) ?? new Date().toISOString();
  const updated = text(root.updated_at) ?? created;
  const sourceOwner = typeof root.project_id === 'number'
    ? ctx.projects.find((project) => Number(project.id) === root.project_id)
    : undefined;
  const ownerProject = sourceOwner && !sourceOwner.is_synthetic
    ? Number(sourceOwner.id)
    : links.length === 1
      ? links[0].project_id
      : null;
  return {
    schema_version: 1,
    id: asSessionId(plan.uuid),
    kind: plan.identity.kind,
    created_at: created,
    updated_at: updated,
    storage_scope: plan.scope === 'global'
      ? { kind: 'global' }
      : { kind: 'project', project_id: ownerProject! },
    owner_project_id: ownerProject,
    linked_projects: links,
    parent_session_id: parentSessionUuid(ctx, plan, root) as SessionMetadata['parent_session_id'],
    provider: text(root.provider ?? root.provider_id),
    model: text(root.model ?? root.model_id),
    title: text(root.title ?? root.name),
    favorite: bool(root.favorite ?? root.is_favorite),
    archived_at: text(root.archived_at),
    metadata: {
      runtime_kind: text(root.runtime_kind),
      app_slug: text(root.app_slug),
      stack: text(root.stack ?? root.stack_profile_id),
      ...(plan.identity.kind === 'coder'
        ? {
            coder: {
              agent: text(root.agent),
              favorited_at: text(root.favorited_at),
              usage: {
                total_input_tokens: nonNegativeInteger(root.total_input_tokens),
                total_output_tokens: nonNegativeInteger(root.total_output_tokens),
                total_cache_read_tokens: nonNegativeInteger(
                  root.total_cache_read_tokens,
                ),
                total_cache_creation_tokens: nonNegativeInteger(
                  root.total_cache_creation_tokens,
                ),
                last_turn_input_tokens: nonNegativeInteger(
                  root.last_turn_input_tokens,
                ),
              },
              linked_projects: links.map((link) => ({
                ...link,
                name:
                  ctx.projects.find(
                    (project) => Number(project.id) === link.project_id,
                  )?.name ?? String(link.project_id),
                is_primary: link.project_id === ownerProject,
                label: null,
              })),
            },
          }
        : {}),
      ...(plan.identity.kind === 'company'
        ? {
            company: {
              name: text(root.name ?? root.title) ?? 'Company',
              template_id:
                typeof root.template_id === 'number' ? root.template_id : null,
              runtime_kind: 'company',
              config_json:
                typeof root.config_json === 'string' ? root.config_json : '{}',
              master_session_id:
                typeof root.master_session_id === 'string'
                  ? root.master_session_id
                  : null,
              project_labels: {},
              recovered_at: text(root.recovered_at),
              recovered_reason: text(root.recovered_reason),
            },
          }
        : {}),
      ...(plan.identity.kind === 'app_studio'
        ? {
            app_studio: {
              seq: Math.max(1, nonNegativeInteger(root.id)),
              project_id: positiveInteger(
                root.project_id,
                `App Studio ${String(plan.identity.id)} project_id`,
              ),
              company_session_id:
                migratedReference(
                  ctx,
                  'company_sessions',
                  root.company_session_id,
                  `App Studio ${String(plan.identity.id)} company_session_id`,
                ),
              name: text(root.name) ?? 'App Studio',
              app_slug:
                text(root.app_slug) ??
                `migrated-app-${String(plan.identity.id)}`,
              stack_profile_id: 'cf-fullstack-v1',
            },
          }
        : {}),
      ...(plan.identity.kind === 'sprite'
        ? {
            sprite: {
              name: text(root.name ?? root.title) ?? 'Sprites',
              style:
                (parseJson(root.style_json ?? root.style) ?? {}) as JsonValue,
              export_dir: text(root.export_dir) ?? 'assets/sprites',
              settings:
                (parseJson(root.settings_json ?? root.settings) ?? {}) as JsonValue,
            },
          }
        : {}),
      ...(plan.identity.kind === 'design'
        ? {
            design: {
              kind:
                root.company_session_id != null || root.kind === 'company'
                  ? 'company'
                  : 'studio',
              name: text(root.name) ?? 'Design System',
              packageName: text(root.package_name) ?? '',
              stack:
                root.stack === 'vue-ts' || root.stack === 'angular'
                  ? root.stack
                  : 'react-ts',
              sourceZipHash: text(root.source_zip_hash),
              sourceZipRef: null,
              nextBumpHint:
                root.next_bump_hint === 'minor' || root.next_bump_hint === 'major'
                  ? root.next_bump_hint
                  : 'patch',
              mcpServerConfigId: text(root.mcp_server_config_id),
              mode: root.mode === 'fidelity' ? 'fidelity' : 'creative',
            },
          }
        : {}),
    } as JsonValue as Record<string, JsonValue>,
  };
}

function messageSequenceForLegacyId(
  ctx: ExportContext,
  plan: BundlePlan,
  legacyId: unknown,
): number | null {
  if (legacyId == null || plan.identity.kind !== 'coder') return null;
  const messages = rowsForPlan(ctx.relational, plan, 'coder_messages')
    .sort((left, right) => left.legacyRowId - right.legacyRowId);
  const index = messages.findIndex((stub) => {
    const row = fullRow(ctx.db, stub);
    return String(row.id ?? stub.legacyRowId) === String(legacyId);
  });
  return index < 0 ? null : index + 1;
}

function disabledTools(
  ctx: ExportContext,
  plan: BundlePlan,
): string[] {
  if (
    plan.identity.kind !== 'coder' ||
    !tableExists(ctx.db, 'session_disabled_tools')
  ) {
    return [];
  }
  return (
    ctx.db.prepare(
      `SELECT tool_name FROM session_disabled_tools
       WHERE session_id = ? ORDER BY tool_name`,
    ).all(plan.identity.id) as Array<{ tool_name: string }>
  ).map((row) => row.tool_name);
}

function activeSkills(
  ctx: ExportContext,
  plan: BundlePlan,
  root: Record<string, unknown>,
): string[] {
  if (
    plan.identity.kind !== 'coder' ||
    !tableExists(ctx.db, 'skill_definitions')
  ) {
    return [];
  }
  const projectIds = new Set(
    linkedProjects(ctx.db, plan, root, ctx.projects).map(
      (project) => String(project.project_id),
    ),
  );
  const overrides = new Map<string, boolean>();
  if (tableExists(ctx.db, 'skill_session_config')) {
    const rows = ctx.db.prepare(
      `SELECT skill_id, enabled FROM skill_session_config WHERE session_id = ?`,
    ).all(plan.identity.id) as Array<{ skill_id: string; enabled: unknown }>;
    for (const row of rows) overrides.set(row.skill_id, bool(row.enabled));
  }
  const rows = ctx.db.prepare(
    `SELECT id, scope, enabled FROM skill_definitions
     ORDER BY COALESCE(sort_order, 0), name, id`,
  ).all() as Array<{ id: string; scope: string; enabled: unknown }>;
  return rows
    .filter(
      (row) => row.scope === 'global' || projectIds.has(String(row.scope)),
    )
    .filter((row) => overrides.get(row.id) ?? bool(row.enabled))
    .map((row) => row.id);
}

function pendingAgentTransition(
  ctx: ExportContext,
  plan: BundlePlan,
): JsonValue | null {
  if (
    plan.identity.kind !== 'coder' ||
    !tableExists(ctx.db, 'coder_pending_agent_transitions')
  ) {
    return null;
  }
  const row = ctx.db.prepare(
    `SELECT from_agent, to_agent, updated_at
     FROM coder_pending_agent_transitions WHERE session_id = ?`,
  ).get(plan.identity.id) as
    | {
        from_agent: string | null;
        to_agent: string | null;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    id: deterministicUuid(`pending-agent-transition:${plan.uuid}`),
    sessionId: plan.uuid,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    seq: 1,
    updatedAt: isoTimestamp(row.updated_at, new Date().toISOString()),
  };
}

function createState(
  ctx: ExportContext,
  plan: BundlePlan,
  root: Record<string, unknown>,
  projection: Record<string, unknown>,
): SessionState {
  const updated = text(root.updated_at) ?? text(root.created_at) ?? new Date().toISOString();
  const goalText = text(root.goal_text);
  const goalCreatedAt =
    text(root.goal_created_at) ?? text(root.created_at) ?? updated;
  const goalStatus =
    root.goal_status === 'complete' || root.goal_status === 'superseded'
      ? root.goal_status
      : 'in_progress';
  const boundarySeq = messageSequenceForLegacyId(
    ctx,
    plan,
    root.summary_boundary_id,
  );
  const distilledSeq = messageSequenceForLegacyId(
    ctx,
    plan,
    root.memory_distilled_message_id,
  );
  const permissionGrants = parseJson(root.tool_permission_grants);
  const runtime = normalizeInterrupted({
    temperature_override: root.temperature_override ?? null,
    reasoning_effort_override: root.reasoning_effort_override ?? null,
    execution_mode_override: root.execution_mode_override ?? 'standard',
    thinking_enabled: bool(root.thinking_enabled),
    plan_depth_override: root.plan_depth_override ?? null,
    response_language_override: root.response_language_override ?? null,
    output_style_override: root.output_style_override ?? null,
    preflight_seed_json: root.preflight_seed_json ?? null,
    unrestricted_tool_output:
      root.unrestricted_tool_output == null
        ? null
        : bool(root.unrestricted_tool_output),
    tool_output_cap_level: root.tool_output_cap_level ?? null,
    last_response_id: root.last_response_id ?? null,
    last_response_message_count:
      root.last_response_message_count == null
        ? null
        : nonNegativeInteger(root.last_response_message_count),
    worktree_path: root.worktree_path ?? null,
    fallback_provider: root.fallback_provider ?? null,
    fallback_model: root.fallback_model ?? null,
    cloudcode_session_id: root.cloudcode_session_id ?? null,
    base_commit_sha: root.base_commit_sha ?? null,
    last_review_at: root.last_review_at ?? null,
    memory_distilled_seq: distilledSeq ?? 0,
    memory_distill_attempts: nonNegativeInteger(root.memory_distill_attempts),
    pending_agent_transition: pendingAgentTransition(ctx, plan),
    config_lock: parseJson(root.session_config_lock_json) ?? null,
    group_id: projection.group_id ?? null,
  }) as Record<string, JsonValue>;
  return {
    schema_version: 1,
    status: String(normalizeStatus(root.status ?? 'idle')),
    updated_at: updated,
    archived_at: text(root.archived_at),
    goal: goalText
      ? {
          id: deterministicUuid(`goal:${plan.uuid}`),
          text: goalText,
          status: goalStatus,
          budget_tokens:
            typeof root.goal_budget_tokens === 'number'
              ? root.goal_budget_tokens
              : null,
          completion_note: text(root.goal_completion_note),
          created_at: goalCreatedAt,
          updated_at: text(root.goal_updated_at) ?? updated,
        }
      : null,
    todos: (parseJson(root.todos_json ?? root.tasks_json) ?? []) as JsonValue[],
    permissions: {
      mode: text(root.tool_permission_mode),
      grants: Array.isArray(permissionGrants)
        ? permissionGrants.filter(
            (item): item is string => typeof item === 'string',
          )
        : [],
    },
    tools: {
      disabled: disabledTools(ctx, plan),
      profile: text(root.tool_profile),
      toolset: (parseJson(root.tool_state_json) ?? {}) as JsonValue,
      tool_output_cap_level: (root.tool_output_cap_level ?? null) as JsonValue,
      unrestricted_tool_output: (root.unrestricted_tool_output ?? null) as JsonValue,
      active_skills: activeSkills(ctx, plan, root),
    },
    compaction: {
      boundary_seq: boundarySeq ?? 0,
      summary: text(root.compaction_summary),
      count_auto: nonNegativeInteger(root.compaction_count_auto),
      count_manual: nonNegativeInteger(root.compaction_count_manual),
    },
    cursors: {},
    extra: {
      runtime,
      legacy: normalizeInterrupted(projection) as JsonValue,
      ...(plan.identity.kind === 'design'
        ? {
            design: {
              pipelineJson: text(root.pipeline_json),
            },
          }
        : {}),
    },
  };
}

export function categoryForTable(plan: BundlePlan, table: string): string {
  // Mixed global/session tables must retain their semantic category regardless
  // of whether the owning bundle is coder, Company, or App Studio. Checking
  // this before the kind-specific routing prevents Company metrics from being
  // mislabeled as workflow steps.
  const sharedSessionCategories: Readonly<Record<string, string>> = {
    pipeline_telemetry: join('metrics', 'pipeline_stages'),
    counterfactual_logs: join('metrics', 'counterfactual'),
    quality_classifications: join('metrics', 'quality_classifications'),
    quality_interventions: join('events', 'quality_interventions'),
    company_drive_files: join('company', 'drive-files'),
    pipeline_provider_bindings: join('events', 'pipeline-provider-bindings'),
    sub_agent_result_cache: join('subagents', 'cache'),
  };
  const sharedCategory = sharedSessionCategories[table];
  if (sharedCategory) return sharedCategory;

  if (plan.identity.kind === 'design') {
    if (table === 'design_system_versions') return join('design', 'versions');
    if (table === 'design_system_components') return join('design', 'components');
    return join('design', 'legacy');
  }
  if (plan.identity.kind === 'app_studio') {
    const sharedCompanyDirectories: Record<string, string> = {
      pipelines: 'pipeline-definitions',
      qa_test_runs: 'qa-runs',
      qa_test_results: 'qa-results',
      pipeline_executions: 'pipeline-runs',
      pipeline_node_executions: 'pipeline-node-executions',
    };
    if (sharedCompanyDirectories[table]) {
      return join('company', sharedCompanyDirectories[table]);
    }
    const appStudioDirectories: Record<string, string> = {
      app_studio_plan_revisions: 'plan-revisions',
      app_studio_work_items: 'work-items',
      app_studio_work_item_runs: 'work-item-runs',
      app_studio_decisions: 'decisions',
      app_studio_events: 'events',
      app_studio_deployments: 'deployments',
    };
    return join(
      'company',
      'app-studio',
      appStudioDirectories[table] ?? join('legacy', table),
    );
  }
  if (plan.identity.kind === 'company') {
    const companyDirectories: Record<string, string> = {
      company_board: 'board-items',
      agent_inbox: 'inbox-messages',
      kanban_cards: 'kanban-cards',
      kanban_card_agents: 'kanban-cards',
      kanban_card_dependencies: 'kanban-cards',
      kanban_checklist_items: 'kanban-cards',
      kanban_comments: 'kanban-cards',
      company_agent_runs: 'agent-runs',
      company_master_prompts: 'master-prompts',
      pipelines: 'pipeline-definitions',
      qa_test_runs: 'qa-runs',
      qa_test_results: 'qa-results',
      company_sandbox_services: 'services',
      company_service_transitions: 'services',
      company_session_envs: 'environments',
      company_sandboxes: 'sandboxes',
      company_service_logs: 'logs',
      pipeline_executions: 'pipeline-runs',
      pipeline_node_executions: 'pipeline-node-executions',
      company_session_archives: 'archives',
    };
    const directory =
      companyDirectories[table] ??
      (table.includes('agent') ? 'agents' : 'workflow-steps');
    return join('company', directory);
  }
  if (plan.identity.kind === 'sprite') {
    const spriteDirectories: Record<string, string> = {
      sprite_assets: 'assets',
      sprite_asset_versions: 'versions',
      sprite_references: 'versions',
      sprite_generation_jobs: 'jobs',
      sprite_animations: 'animations',
      sprite_frames: 'frames',
    };
    return join('sprite', spriteDirectories[table] ?? 'assets');
  }
  if (table.includes('chapter')) return 'chapters';
  if (table.includes('plan')) return 'plans';
  if (table.includes('task')) return 'tasks';
  if (table.includes('input')) return 'inputs';
  if (table.includes('memory')) return 'memory';
  if (table.includes('subagent')) return 'subagents';
  if (table.includes('snapshot') || table.includes('file_')) return join('snapshots', table);
  if (table === 'coder_provider_attempts') return join('metrics', 'provider_attempts');
  if (table.includes('telemetry') || table.includes('attempt')) return join('metrics', table);
  if (table.includes('checkpoint')) return 'checkpoints';
  return join('events', table);
}

function entityKind(plan: BundlePlan, table: string): string {
  if (plan.identity.kind === 'design') {
    if (table === 'design_system_versions') return 'version';
    if (table === 'design_system_components') return 'component';
    return `legacy.${table}`;
  }
  if (plan.identity.kind === 'app_studio') {
    const sharedCompanyKinds: Record<string, string> = {
      pipelines: 'pipelineDefinition',
      qa_test_runs: 'qaRun',
      qa_test_results: 'qaResult',
      pipeline_executions: 'pipelineRun',
      pipeline_node_executions: 'pipelineNodeExecution',
    };
    if (sharedCompanyKinds[table]) return sharedCompanyKinds[table];
    const appStudioKinds: Record<string, string> = {
      app_studio_plan_revisions: 'plan_revision',
      app_studio_work_items: 'work_item',
      app_studio_work_item_runs: 'work_item_run',
      app_studio_decisions: 'decision',
      app_studio_events: 'event',
      app_studio_deployments: 'deployment',
    };
    return appStudioKinds[table] ?? `legacy_${table}`;
  }
  if (plan.identity.kind === 'company') {
    const companyKinds: Record<string, string> = {
      company_board: 'boardItem',
      agent_inbox: 'inboxMessage',
      kanban_cards: 'kanbanCard',
      kanban_card_agents: 'kanbanCard',
      kanban_card_dependencies: 'kanbanCard',
      kanban_checklist_items: 'kanbanCard',
      kanban_comments: 'kanbanCard',
      company_agent_runs: 'agentRun',
      company_master_prompts: 'masterPrompt',
      pipelines: 'pipelineDefinition',
      qa_test_runs: 'qaRun',
      qa_test_results: 'qaResult',
      company_sandbox_services: 'service',
      company_service_transitions: 'service',
      company_session_envs: 'environment',
      company_sandboxes: 'sandbox',
      company_service_logs: 'log',
      pipeline_executions: 'pipelineRun',
      pipeline_node_executions: 'pipelineNodeExecution',
      company_session_archives: 'archive',
    };
    return companyKinds[table] ??
      (table.includes('agent') ? 'agent' : 'workflowStep');
  }
  if (plan.identity.kind === 'sprite') {
    const spriteKinds: Record<string, string> = {
      sprite_assets: 'asset',
      sprite_asset_versions: 'version',
      sprite_references: 'version',
      sprite_generation_jobs: 'job',
      sprite_animations: 'animation',
      sprite_frames: 'frame',
    };
    return spriteKinds[table] ?? 'asset';
  }
  const coderKinds: Record<string, string> = {
    coder_plans: 'plan',
    coder_tasks_state: 'task_board',
    coder_task_runs: 'task_run',
    coder_task_run_items: 'task_run_item',
    coder_session_inputs: 'session_input',
    coder_session_memory: 'memory',
    coder_session_filesystem_roots: 'filesystem_root',
    coder_provider_attempts: 'provider_attempt',
    coder_pending_agent_transitions: 'pending_agent_transition',
    coder_orchestration_checkpoints: 'orchestration_checkpoint',
    coder_compaction_attempts: 'compaction_attempt',
    coder_subagent_runs: 'subagent_run',
    coder_subagent_tool_calls: 'subagent_tool_call',
    coder_session_chapters: 'conversation_chapter',
    session_disabled_tools: 'disabled_tool',
  };
  return coderKinds[table] ?? `legacy.${table}`;
}

const APP_STUDIO_RUNTIME_TABLES = new Set([
  'app_studio_plan_revisions',
  'app_studio_work_items',
  'app_studio_work_item_runs',
  'app_studio_decisions',
  'app_studio_events',
  'app_studio_deployments',
]);

function appStudioEntityUuid(
  ctx: ExportContext,
  plan: BundlePlan,
  table: string,
  legacyId: unknown,
  label: string,
): string {
  const candidates = rowsForPlan(ctx.relational, plan, table);
  const value = String(legacyId);
  const row = candidates.find((candidate) => {
    if (candidate.entityUuid === value) return true;
    return String(fullRow(ctx.db, candidate).id) === value;
  });
  if (!row) {
    throw new Error(
      `App Studio ${String(plan.identity.id)} cannot remap ${label}=${value}`,
    );
  }
  return row.entityUuid;
}

function appStudioJsonText(
  value: unknown,
  fallback: JsonValue,
  label: string,
): string {
  if (value == null || value === '') return JSON.stringify(fallback);
  if (typeof value !== 'string') return JSON.stringify(value);
  try {
    return JSON.stringify(JSON.parse(value) as JsonValue);
  } catch (error) {
    throw new Error(`Invalid legacy App Studio ${label}`, { cause: error });
  }
}

function appStudioWorkItemIdsJson(
  ctx: ExportContext,
  plan: BundlePlan,
  value: unknown,
  label: string,
): string {
  const parsed = JSON.parse(appStudioJsonText(value, [], label)) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string')
  ) {
    throw new Error(`Legacy App Studio ${label} must be a string array`);
  }
  return JSON.stringify(
    parsed.map((id) =>
      appStudioEntityUuid(
        ctx,
        plan,
        'app_studio_work_items',
        id,
        label,
      ),
    ),
  );
}

function appStudioEventEntityId(
  ctx: ExportContext,
  plan: BundlePlan,
  source: Record<string, unknown>,
): string {
  const legacyId = source.entity_id;
  const entityType = text(source.entity_type);
  const table = entityType === 'plan_revision'
    ? 'app_studio_plan_revisions'
    : entityType === 'work_item'
      ? 'app_studio_work_items'
      : entityType === 'work_item_run'
        ? 'app_studio_work_item_runs'
        : entityType === 'decision'
          ? 'app_studio_decisions'
          : entityType === 'deployment'
            ? 'app_studio_deployments'
            : null;
  if (!table) return text(legacyId) ?? String(legacyId ?? plan.uuid);
  return appStudioEntityUuid(
    ctx,
    plan,
    table,
    legacyId,
    `event ${entityType} entity_id`,
  );
}

function migratedEntityData(
  ctx: ExportContext,
  plan: BundlePlan,
  table: string,
  stub: MigratedRowStub,
  source: Record<string, unknown>,
  migrated: Record<string, unknown>,
): Record<string, unknown> {
  const {
    schema_version: _schemaVersion,
    id: _id,
    created_at: _createdAt,
    updated_at: _updatedAt,
    _entity_type: _entityType,
    ...base
  } = migrated;
  if (plan.identity.kind === 'design') {
    if (table === 'design_system_versions') {
      return {
        semver: text(source.semver) ?? '0.0.0',
        bumpKind:
          source.bump_kind === 'initial'
          || source.bump_kind === 'minor'
          || source.bump_kind === 'major'
            ? source.bump_kind
            : 'patch',
        isAutoBump: bool(source.is_auto_bump),
        status:
          source.status === 'building'
          || source.status === 'published'
          || source.status === 'failed'
          || source.status === 'skipped'
            ? source.status
            : 'draft',
        sourceHash: text(source.source_hash),
        tarballRef:
          migrated.tarball_ref != null
          && typeof migrated.tarball_ref === 'object'
          && !Array.isArray(migrated.tarball_ref)
            ? migrated.tarball_ref
            : null,
        manifestJson:
          typeof source.manifest_json === 'string' ? source.manifest_json : null,
        mcpManifestJson:
          typeof source.mcp_manifest_json === 'string'
            ? source.mcp_manifest_json
            : null,
        docsMarkdown: text(source.docs_md),
        storybookPath: text(source.storybook_path),
        error: text(source.error),
        publishedAt: text(source.published_at),
      };
    }
    if (table === 'design_system_components') {
      return {
        versionId: text(migrated.version_id) ?? '',
        name: text(source.name) ?? 'Legacy component',
        componentKind:
          source.kind === 'page-template' ? 'page-template' : 'atom',
        propsSchemaJson:
          typeof source.props_schema_json === 'string'
            ? source.props_schema_json
            : null,
        exampleCode:
          typeof source.example_code === 'string' ? source.example_code : null,
      };
    }
  }
  if (plan.identity.kind === 'app_studio') {
    if (table === 'app_studio_plan_revisions') {
      return {
        revision_number: positiveInteger(
          source.revision_number,
          `App Studio plan revision ${String(source.id)} revision_number`,
        ),
        status: text(migrated.status) ?? 'draft',
        plan_json: appStudioJsonText(source.plan_json, {}, 'plan_json'),
        fitness_json: appStudioJsonText(
          source.fitness_json,
          {},
          'fitness_json',
        ),
        created_by: text(source.created_by) ?? 'app_orchestrator',
        approved_at: text(source.approved_at),
      };
    }
    if (table === 'app_studio_work_items') {
      return {
        source_id: String(source.id),
        plan_revision_id: appStudioEntityUuid(
          ctx,
          plan,
          'app_studio_plan_revisions',
          source.plan_revision_id,
          'work item plan_revision_id',
        ),
        slice_id: text(source.slice_id),
        title: text(source.title) ?? 'Legacy work item',
        outcome: text(source.outcome) ?? '',
        kind: text(source.kind) ?? 'implement',
        owner_role: text(source.owner_role) ?? 'fullstack',
        priority: nonNegativeInteger(source.priority),
        status: text(migrated.status) ?? 'backlog',
        sort_order: nonNegativeInteger(source.sort_order),
        depends_on_json: appStudioWorkItemIdsJson(
          ctx,
          plan,
          source.depends_on_json,
          `work item ${String(source.id)} depends_on_json`,
        ),
        source_ids_json: appStudioJsonText(
          source.source_ids_json,
          [],
          `work item ${String(source.id)} source_ids_json`,
        ),
        acceptance_json: appStudioJsonText(
          source.acceptance_json,
          [],
          `work item ${String(source.id)} acceptance_json`,
        ),
        evidence_json: appStudioJsonText(
          source.evidence_json,
          [],
          `work item ${String(source.id)} evidence_json`,
        ),
        file_scope_json: appStudioJsonText(
          source.file_scope_json,
          [],
          `work item ${String(source.id)} file_scope_json`,
        ),
        blocked_reason: text(source.blocked_reason),
      };
    }
    if (table === 'app_studio_work_item_runs') {
      return {
        work_item_id: appStudioEntityUuid(
          ctx,
          plan,
          'app_studio_work_items',
          source.work_item_id,
          'work item run work_item_id',
        ),
        attempt: positiveInteger(
          source.attempt,
          `App Studio work item run ${String(source.id)} attempt`,
        ),
        role: text(source.role) ?? 'fullstack',
        company_agent_run_id: migratedReference(
          ctx,
          'company_agent_runs',
          source.company_agent_run_id,
          `App Studio work item run ${String(source.id)} company_agent_run_id`,
        ),
        coder_session_id: migratedReference(
          ctx,
          'coder_sessions',
          source.coder_session_id,
          `App Studio work item run ${String(source.id)} coder_session_id`,
        ),
        status: text(migrated.status) ?? 'interrupted',
        runtime_config_hash: text(source.runtime_config_hash),
        idempotency_key:
          text(source.idempotency_key) ??
          `legacy-app-run:${stub.entityUuid}`,
        status_message: text(source.status_message),
        started_at: text(source.started_at),
        completed_at: text(source.completed_at),
      };
    }
    if (table === 'app_studio_decisions') {
      return {
        plan_revision_id: appStudioEntityUuid(
          ctx,
          plan,
          'app_studio_plan_revisions',
          source.plan_revision_id,
          'decision plan_revision_id',
        ),
        question: text(source.question) ?? 'Legacy decision',
        options_json: appStudioJsonText(
          source.options_json,
          [],
          'decision options_json',
        ),
        blocked_work_item_ids_json: appStudioWorkItemIdsJson(
          ctx,
          plan,
          source.blocked_work_item_ids_json,
          'decision blocked_work_item_ids_json',
        ),
        status: text(source.status) ?? 'open',
        answer: text(source.answer),
        requested_at:
          text(source.requested_at) ??
          text(source.created_at) ??
          new Date().toISOString(),
        resolved_at: text(source.resolved_at),
      };
    }
    if (table === 'app_studio_events') {
      return {
        kind: text(source.kind) ?? 'legacy.event',
        entity_type: text(source.entity_type) ?? 'session',
        entity_id: appStudioEventEntityId(ctx, plan, source),
        payload_json: appStudioJsonText(
          source.payload_json,
          {},
          'event payload_json',
        ),
        idempotency_key: text(source.idempotency_key),
      };
    }
    if (table === 'app_studio_deployments') {
      return {
        plan_revision_id: appStudioEntityUuid(
          ctx,
          plan,
          'app_studio_plan_revisions',
          source.plan_revision_id,
          'deployment plan_revision_id',
        ),
        status: text(source.status) ?? 'failed',
        url: text(source.url),
        account: text(source.account),
        database_id: text(source.database_id),
        health_ok: bool(source.health_ok) ? 1 : 0,
        details_json: appStudioJsonText(
          source.details_json,
          {},
          'deployment details_json',
        ),
      };
    }
  }
  if (table === 'coder_plans') {
    const messageId = text(migrated.message_id);
    const messages = rowsForPlan(ctx.relational, plan, 'coder_messages')
      .sort((left, right) => left.legacyRowId - right.legacyRowId);
    const messageIndex = messageId
      ? messages.findIndex((message) => message.entityUuid === messageId)
      : -1;
    return {
      ...base,
      tool_use_id: text(source.tool_use_id) ?? `legacy-plan:${stub.entityUuid}`,
      message_seq: messageIndex < 0 ? null : messageIndex + 1,
      plan_text: text(source.plan_text) ?? '',
      status: text(source.status) ?? 'pending',
      feedback: text(source.feedback),
      resolved_at: text(source.resolved_at),
    };
  }
  if (table === 'coder_tasks_state') {
    return {
      ...base,
      tool_use_id: text(source.tool_use_id) ?? `legacy-tasks:${stub.entityUuid}`,
      state: (parseJson(source.state) ?? {}) as JsonValue,
    };
  }
  if (table === 'coder_session_inputs') {
    return {
      ...base,
      kind: text(source.kind) ?? 'text',
      source_label: text(source.source_label) ?? 'legacy',
      content: typeof source.content === 'string' ? source.content : '',
      content_hash:
        text(source.content_hash) ??
        sha256Bytes(Buffer.from(String(source.content ?? ''), 'utf8')),
      meta: (parseJson(source.meta_json) ?? null) as JsonValue,
    };
  }
  if (table === 'coder_session_memory') {
    return {
      ...base,
      kind: text(source.kind) ?? 'fact',
      title: text(source.title) ?? 'Legacy memory',
      body: typeof source.body === 'string' ? source.body : '',
      pinned: bool(source.pinned),
    };
  }
  if (table === 'coder_session_chapters') {
    const messages = rowsForPlan(ctx.relational, plan, 'coder_messages')
      .sort((left, right) => left.legacyRowId - right.legacyRowId);
    const messageSequence = (legacyId: unknown, label: string): number => {
      const value = String(legacyId);
      const index = messages.findIndex((message) => {
        if (message.entityUuid === value) return true;
        return String(fullRow(ctx.db, message).id) === value;
      });
      if (index < 0) {
        throw new Error(
          `Cannot remap coder chapter ${String(source.id)} ${label}=${value} to a conversation sequence`,
        );
      }
      return index + 1;
    };
    const sourceKind =
      source.source === 'auto'
      || source.source === 'manual'
      || source.source === 'legacy'
      || source.source === 'rebuild'
      || source.source === 'import'
        ? source.source
        : 'legacy';
    return {
      start_message_seq: messageSequence(
        source.start_message_id,
        'start_message_id',
      ),
      end_message_seq: messageSequence(
        source.end_message_id,
        'end_message_id',
      ),
      source: sourceKind,
      trigger: text(source.trigger) ?? '',
      title: text(source.title) ?? 'Legacy chapter',
      chapter_json: jsonText(source.chapter_json, {}),
      chapter_text: text(source.chapter_text) ?? '',
      resume_json: jsonText(source.resume_json, {}),
      resume_text: text(source.resume_text) ?? '',
      version: Math.max(1, nonNegativeInteger(source.version)),
      metrics_json:
        source.metrics_json == null
          ? null
          : jsonText(source.metrics_json, {}),
      superseded_at: text(source.superseded_at),
      chapter_kind:
        source.chapter_kind === 'context'
        || source.chapter_kind === 'milestone'
        || source.chapter_kind === 'rebuild'
          ? source.chapter_kind
          : 'context',
      advances_context_boundary:
        source.advances_context_boundary === 0
        || source.advances_context_boundary === '0'
          ? 0
          : 1,
    };
  }
  if (table === 'coder_subagent_runs') {
    const runId = normalizedUuid(
      source.run_id,
      `legacy-subagent-run:${String(source.run_id ?? stub.entityUuid)}`,
    );
    const normalizedParentRunId = source.parent_run_id == null
      ? null
      : normalizedUuid(
          source.parent_run_id,
          `legacy-subagent-run:${String(source.parent_run_id)}`,
        );
    const status =
      source.status === 'completed'
        ? 'completed'
        : source.status === 'running'
        || source.status === 'queued'
        || source.status === 'starting'
          ? 'interrupted'
          : source.status === 'interrupted'
            ? 'interrupted'
            : source.completed_at != null
              ? 'completed'
              : 'interrupted';
    const capabilities = parseJson(source.effective_capabilities_json);
    return {
      ...base,
      session_id: plan.uuid,
      run_id: runId,
      parent_run_id: normalizedParentRunId,
      parent_agent_run_id: null,
      spawn_id: text(source.spawn_id),
      profile: text(source.profile) ?? 'explore',
      label: text(source.label),
      task_preview: text(source.task_preview),
      requested_provider: text(source.requested_provider),
      requested_model: text(source.requested_model),
      requested_reasoning_effort: text(source.requested_reasoning_effort),
      wait_mode: source.wait_mode === 'background' ? 'background' : 'foreground',
      effective_provider: text(source.effective_provider),
      effective_model: text(source.effective_model),
      effective_reasoning_effort: text(source.effective_reasoning_effort),
      effective_capabilities: Array.isArray(capabilities)
        ? capabilities.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      environment_fingerprint: text(source.environment_fingerprint),
      policy_mode: text(source.policy_mode),
      max_turns: nonNegativeInteger(source.max_turns),
      max_tool_calls:
        source.max_tool_calls == null
          ? null
          : nonNegativeInteger(source.max_tool_calls),
      timeout_ms:
        source.timeout_ms == null
          ? null
          : nonNegativeInteger(source.timeout_ms),
      stall_ms:
        source.stall_ms == null
          ? null
          : nonNegativeInteger(source.stall_ms),
      research_depth: text(source.research_depth),
      soft_tool_target:
        source.soft_tool_target == null
          ? null
          : nonNegativeInteger(source.soft_tool_target),
      soft_time_target_ms:
        source.soft_time_target_ms == null
          ? null
          : nonNegativeInteger(source.soft_time_target_ms),
      status,
      reason: text(source.reason),
      turns: nonNegativeInteger(source.turns),
      auto_continues: nonNegativeInteger(source.auto_continues),
      tool_calls: nonNegativeInteger(source.tool_calls),
      logical_operations: nonNegativeInteger(source.logical_operations),
      productive_operations: nonNegativeInteger(source.productive_operations),
      paginate_calls: nonNegativeInteger(source.paginate_calls),
      duplicate_calls: nonNegativeInteger(source.duplicate_calls),
      error_calls: nonNegativeInteger(source.error_calls),
      refused_calls: nonNegativeInteger(source.refused_calls),
      elapsed_ms:
        source.elapsed_ms == null ? null : nonNegativeInteger(source.elapsed_ms),
      input_tokens:
        source.input_tokens == null ? null : nonNegativeInteger(source.input_tokens),
      output_tokens:
        source.output_tokens == null ? null : nonNegativeInteger(source.output_tokens),
      cache_read_input_tokens:
        source.cache_read_input_tokens == null
          ? null
          : nonNegativeInteger(source.cache_read_input_tokens),
      cache_creation_input_tokens:
        source.cache_creation_input_tokens == null
          ? null
          : nonNegativeInteger(source.cache_creation_input_tokens),
      has_summary: bool(source.has_summary),
      output_id: text(source.output_id),
      synthesis_nudged: bool(source.synthesis_nudged),
      started_at: text(source.started_at) ?? text(source.created_at) ?? new Date().toISOString(),
      heartbeat_at:
        text(source.heartbeat_at)
        ?? text(source.completed_at)
        ?? text(source.started_at)
        ?? new Date().toISOString(),
      completed_at: text(source.completed_at),
      worker_instance_id:
        text(source.worker_instance_id) ?? `legacy:${stub.entityUuid}`,
      fence_token: normalizedUuid(
        source.fence_token,
        `legacy-subagent-fence:${stub.entityUuid}`,
      ),
    };
  }
  if (table === 'coder_subagent_tool_calls') {
    return {
      ...base,
      session_id: plan.uuid,
      run_id: normalizedUuid(
        source.run_id,
        `legacy-subagent-run:${String(source.run_id ?? stub.entityUuid)}`,
      ),
      seq: Math.max(1, nonNegativeInteger(source.seq)),
      turn:
        source.turn == null ? null : nonNegativeInteger(source.turn),
      tool_name: text(source.tool_name) ?? 'unknown_tool',
      logical_operation_id: text(source.logical_operation_id),
      productive: bool(source.productive),
      is_error: bool(source.is_error),
      refusal_kind: text(source.refusal_kind),
      duration_ms: nonNegativeInteger(source.duration_ms),
      result_chars: nonNegativeInteger(source.result_chars),
      created_at: text(source.created_at) ?? new Date().toISOString(),
    };
  }
  if (table === 'coder_task_runs') {
    return {
      ...base,
      run_id: stub.entityUuid,
      session_id: plan.uuid,
    };
  }
  if (table === 'coder_task_run_items') {
    return {
      ...base,
      session_id: plan.uuid,
      attempt: nonNegativeInteger(source.attempt),
      wave_idx: nonNegativeInteger(source.wave_idx),
      tool_call_count: nonNegativeInteger(source.tool_call_count),
      input_tokens: nonNegativeInteger(source.input_tokens),
      output_tokens: nonNegativeInteger(source.output_tokens),
    };
  }
  if (table === 'coder_session_filesystem_roots') {
    return {
      ...base,
      root_path: text(source.root_path) ?? '',
      access: source.access === 'write' ? 'write' : 'read',
    };
  }
  if (table === 'coder_provider_attempts') {
    return {
      ...base,
      run_id: text(source.run_id) ?? stub.entityUuid,
      turn: nonNegativeInteger(source.turn),
      attempt: Math.max(1, nonNegativeInteger(source.attempt)),
      ok: bool(source.ok),
      duration_ms: nonNegativeInteger(source.duration_ms),
      metadata: (parseJson(source.metadata_json) ?? {}) as JsonValue,
    };
  }
  if (plan.identity.kind === 'sprite') {
    const product = migrated.product_file;
    const normalizedProduct =
      product != null &&
      typeof product === 'object' &&
      !Array.isArray(product) &&
      typeof (product as Record<string, unknown>).project_relative_path === 'string'
        ? {
            path: (product as Record<string, unknown>).project_relative_path,
            sha256: (product as Record<string, unknown>).sha256,
            sizeBytes: (product as Record<string, unknown>).size_bytes,
          }
        : undefined;
    return {
      ...base,
      name:
        text(source.name) ??
        text(source.title) ??
        text(source.label) ??
        `Legacy ${entityKind(plan, table)}`,
      status: String(normalizeStatus(source.status ?? 'idle')),
      ...(normalizedProduct ? { product: normalizedProduct } : {}),
      ...(table === 'sprite_asset_versions'
        ? { version: nonNegativeInteger(source.version ?? source.version_number) }
        : {}),
      ...(table === 'sprite_generation_jobs'
        ? { jobType: text(source.job_type ?? source.kind) ?? 'legacy' }
        : {}),
      ...(table === 'sprite_frames'
        ? { frameIndex: nonNegativeInteger(source.frame_index ?? source.idx) }
        : {}),
    };
  }
  if (
    plan.identity.kind === 'company'
    && table === 'company_agent_runs'
  ) {
    const coderSessionId = migratedReference(
      ctx,
      'coder_sessions',
      source.coder_session_id,
      `Company agent run ${String(source.id)} coder_session_id`,
    );
    const rawProjectIds = parseJson(source.project_ids_json);
    const projectIds = Array.isArray(rawProjectIds)
      ? rawProjectIds.filter(
          (value): value is number => Number.isSafeInteger(value),
        )
      : [];
    return {
      ...base,
      coder_session_id: coderSessionId ?? stub.entityUuid,
      project_ids: projectIds,
      status: String(normalizeStatus(source.status ?? 'interrupted')),
      ...(coderSessionId == null
        ? { legacy_coder_session_unavailable: true }
        : {}),
    };
  }
  if (plan.identity.kind === 'company' || plan.identity.kind === 'app_studio') {
    const kind = entityKind(plan, table);
    if (kind === 'pipelineDefinition') {
      const graph = parseJson(source.graph_json);
      if (
        graph == null ||
        typeof graph !== 'object' ||
        Array.isArray(graph)
      ) {
        throw new Error(
          `Invalid legacy pipeline ${String(source.id)} graph_json`,
        );
      }
      return {
        ...base,
        name: text(source.name) ?? 'Legacy pipeline',
        description: text(source.description) ?? '',
        graph,
        version: positiveInteger(
          source.version ?? 1,
          `pipeline ${String(source.id)} version`,
        ),
        company_session_id: plan.uuid,
        project_id: null,
        template_id:
          source.template_id == null
            ? null
            : nonNegativeInteger(source.template_id),
      };
    }
    if (kind === 'pipelineRun') {
      return {
        ...base,
        status: String(normalizeStatus(source.status ?? 'interrupted')),
        context: (parseJson(source.context_json) ?? {
          snapshot: { version: 1, nodes: [], edges: [] },
          vars: {},
        }) as JsonValue,
      };
    }
    if (kind === 'pipelineNodeExecution') {
      return {
        ...base,
        status: String(normalizeStatus(source.status ?? 'interrupted')),
      };
    }
    if (kind === 'qaRun' || kind === 'qaResult') {
      return {
        ...base,
        status: String(normalizeStatus(source.status ?? 'interrupted')),
      };
    }
    return {
      ...base,
      ...(kind === 'boardItem' || kind === 'kanbanCard'
        ? { title: text(source.title) ?? text(source.name) ?? 'Legacy item' }
        : {}),
      ...(kind === 'inboxMessage'
        ? {
            subject: text(source.subject) ?? 'Legacy message',
            body: text(source.body ?? source.message) ?? '',
          }
        : {}),
      ...(kind === 'agent'
        ? {
            name: text(source.name) ?? text(source.agent_name) ?? 'Legacy agent',
            role: text(source.role) ?? 'agent',
          }
        : {}),
      ...(kind === 'service'
        ? { name: text(source.name ?? source.service_name) ?? 'Legacy service' }
        : {}),
      ...(kind === 'environment'
        ? { name: text(source.name ?? source.key) ?? 'legacy-environment' }
        : {}),
      ...(kind === 'log'
        ? {
            level: text(source.level) ?? 'info',
            message: text(source.message) ?? '',
          }
        : {}),
      ...(kind === 'appStudioWorkflow' || kind === 'workflowStep'
        ? { name: text(source.name ?? source.title) ?? 'Legacy workflow' }
        : {}),
      status: String(normalizeStatus(source.status ?? 'idle')),
    };
  }
  return base;
}

function entityRelations(
  data: Record<string, unknown>,
): Record<string, string | string[]> {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const relations: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === 'id' || !key.endsWith('_id')) continue;
    if (typeof value === 'string' && uuidPattern.test(value)) {
      relations[key] = value;
    } else if (
      Array.isArray(value) &&
      value.every(
        (item) => typeof item === 'string' && uuidPattern.test(item),
      )
    ) {
      relations[key] = value as string[];
    }
  }
  return relations;
}

function isoTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z');
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : fallback;
}

async function externalizeSnapshotContent(
  table: string,
  row: Record<string, unknown>,
  store: ArtifactStore,
): Promise<Record<string, unknown>> {
  if (!table.startsWith('session_file_')) return row;
  const output = { ...row };
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    // Hashes and review text are semantic scalar fields. Externalize only the
    // three columns whose value is the actual file snapshot payload.
    if (
      key !== 'content_before' &&
      key !== 'content_after' &&
      key !== 'rollback_content'
    ) {
      continue;
    }
    const ref = await store.put({
      kind: 'snapshot_blob',
      data: value,
      media_type: 'text/plain',
      logical_name: `${row.id ?? randomUUID()}-${key}.txt`,
    });
    output[key] = { type: 'artifact_ref', ...ref };
  }
  return output;
}

function sideOutputCandidates(
  ctx: ExportContext,
  plan: BundlePlan,
  outputId: string,
): string[] {
  const sessionId = String(plan.identity.id);
  const candidates = [
    join(ctx.dataDir, 'coder-tool-outputs', sessionId, `${outputId}.txt`),
  ];
  if (plan.projectRoot) {
    candidates.push(
      join(plan.projectRoot, '.mcp-indexer', 'coder', 'tool-outputs', sessionId, `${outputId}.txt`),
    );
  }
  return [...new Set(candidates)];
}

async function exportToolCalls(
  ctx: ExportContext,
  plan: BundlePlan,
  store: ArtifactStore,
  stats: BundleExportStats,
): Promise<Map<string, ToolReference>> {
  const output = new Map<string, ToolReference>();
  const migratedOutputIds = new Set<string>();
  if (plan.identity.kind !== 'coder') return output;
  const rows = rowsForPlan(ctx.relational, plan, 'coder_tool_calls')
    .sort((left, right) => left.legacyRowId - right.legacyRowId)
    .map((stub) => ({ stub, row: fullRow(ctx.db, stub) }));
  const legacyCallIdCounts = new Map<string, number>();
  for (const { stub, row } of rows) {
    const legacyCallId = text(row.tool_use_id) ?? `legacy-tool:${stub.entityUuid}`;
    legacyCallIdCounts.set(
      legacyCallId,
      (legacyCallIdCounts.get(legacyCallId) ?? 0) + 1,
    );
  }
  const legacyCallIdOrdinals = new Map<string, number>();
  const assignedCallIds = new Set<string>();
  const callsDir = join(plan.stagingDir, 'tools_outputs', 'calls');
  mkdirSync(callsDir, { recursive: true });

  for (const { stub, row } of rows) {
    const migratedRow = ctx.relational.transformRow(
      'coder_tool_calls',
      row,
      stub,
    );
    const outputId = text(row.output_id);
    if (outputId) migratedOutputIds.add(outputId);
    const sideFile = outputId
      ? sideOutputCandidates(ctx, plan, outputId).find((path) => existsSync(path))
      : undefined;
    const rawText = sideFile ? readFileSync(sideFile) : null;
    const shapedText = text(row.result_text);
    const raw = rawText == null
      ? null
      : await store.put({
          kind: 'tool_output_raw',
          data: rawText,
          media_type: 'text/plain',
          logical_name: `${stub.entityUuid}.raw.txt`,
        });
    let shaped = shapedText == null
      ? null
      : await store.put({
          kind: 'tool_output_shaped',
          data: shapedText,
          media_type: row.output_format === 'json' ? 'application/json' : 'text/plain',
          logical_name: `${stub.entityUuid}.shaped${row.output_format === 'json' ? '.json' : '.txt'}`,
        });
    const unavailable = outputId && !sideFile
      ? {
          type: 'legacy_artifact_unavailable',
          legacy_ref: outputId,
          reason: 'legacy tool output side-file expired or is missing',
        }
      : null;
    if (unavailable) {
      stats.unavailable.push({
        kind: 'legacy_artifact_unavailable',
        legacy_ref: outputId!,
        reason: unavailable.reason,
      });
    }
    if (raw == null && shaped == null) {
      shaped = await store.put({
        kind: 'tool_output_shaped',
        data: JSON.stringify(
          unavailable ?? {
            type: 'legacy_tool_output_empty',
            legacy_ref: outputId ?? stub.entityUuid,
          },
        ),
        media_type: 'application/json',
        logical_name: `${stub.entityUuid}.unavailable.json`,
      });
    }
    const legacyCallId = text(row.tool_use_id) ?? `legacy-tool:${stub.entityUuid}`;
    const duplicateCount = legacyCallIdCounts.get(legacyCallId) ?? 1;
    const duplicateOrdinal = (legacyCallIdOrdinals.get(legacyCallId) ?? 0) + 1;
    legacyCallIdOrdinals.set(legacyCallId, duplicateOrdinal);
    // Legacy provider retries occasionally persisted two different calls with
    // the same tool_use_id in one message. Keep the last row on the original
    // protocol ID (matching the old last-write-wins lookup), while giving every
    // earlier row a deterministic unique ID so no metadata/output is lost.
    const callId =
      duplicateCount > 1 && duplicateOrdinal < duplicateCount
        ? `legacy-duplicate:${stub.entityUuid}`
        : legacyCallId;
    if (assignedCallIds.has(callId)) {
      throw new Error(
        `unable to assign unique tool call id for ${plan.uuid}: ${callId}`,
      );
    }
    assignedCallIds.add(callId);
    const metadata = normalizeInterrupted({
      output_id: outputId,
      output_chars: row.output_chars ?? null,
      output_chars_shaped: row.output_chars_shaped ?? null,
      output_format: row.output_format ?? null,
      structured_output_chars: row.structured_output_chars ?? null,
      truncated: bool(row.truncated),
      phase: row.phase ?? null,
      refusal_kind: row.refusal_kind ?? null,
      parent_tool_use_id: row.parent_tool_use_id ?? null,
      reduction_kind: row.reduction_kind ?? null,
      reduction_technique: row.reduction_technique ?? null,
      run_id: migratedRow.run_id ?? row.run_id ?? null,
      parent_run_id: migratedRow.parent_run_id ?? row.parent_run_id ?? null,
      is_subagent: bool(row.is_subagent),
      ...(duplicateCount > 1
        ? {
            legacy_tool_use_id: legacyCallId,
            legacy_tool_use_id_collision: true,
            legacy_duplicate_ordinal: duplicateOrdinal,
            legacy_duplicate_count: duplicateCount,
          }
        : {}),
    }) as Record<string, JsonValue>;
    const record: ToolReference['output'] = {
      schema_version: 1,
      id: deterministicUuid(`tool-output:${stub.entityUuid}`),
      call_id: callId,
      created_at: text(row.created_at) ?? new Date().toISOString(),
      raw,
      shaped,
      metadata: {
        ...metadata,
        ...(unavailable ? { unavailable } : {}),
      },
    };
    atomicWriteJson(
      join(
        plan.stagingDir,
        'tools_outputs',
        'calls',
        toolOutputRecordFileName(callId),
      ),
      record,
    );
    output.set(callId, {
      callId,
      toolCallId: stub.entityUuid,
      messageId: text(migratedRow.message_id),
      toolName: text(row.tool_name) ?? 'unknown_tool',
      args: (parseJson(row.args_json) ?? {}) as JsonValue,
      isError: bool(row.is_error),
      durationMs:
        typeof row.duration_ms === 'number' &&
        Number.isFinite(row.duration_ms)
          ? row.duration_ms
          : 0,
      nested: text(row.parent_tool_use_id) != null,
      output: record,
      metadata,
      artifacts: [raw, shaped].filter((ref): ref is ArtifactRef => ref !== null),
    });
    stats.counts.coder_tool_calls = (stats.counts.coder_tool_calls ?? 0) + 1;
  }

  const legacyDirs = [
    join(ctx.dataDir, 'coder-tool-outputs', String(plan.identity.id)),
    ...(plan.projectRoot
      ? [join(plan.projectRoot, '.mcp-indexer', 'coder', 'tool-outputs', String(plan.identity.id))]
      : []),
  ];
  for (const directory of [...new Set(legacyDirs)]) {
    if (!existsSync(directory)) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.txt') continue;
      const outputId = basename(entry.name, '.txt');
      if (migratedOutputIds.has(outputId)) continue;
      const ref = await store.put({
        kind: 'tool_output_raw',
        data: readFileSync(join(directory, entry.name)),
        media_type: 'text/plain',
        logical_name: `legacy-spill-${outputId}.txt`,
      });
      atomicWriteJson(
        join(plan.stagingDir, 'tools_outputs', 'legacy_spills', `${outputId}.json`),
        {
          schema_version: 1,
          output_id: outputId,
          raw: ref,
          migrated_at: new Date().toISOString(),
        },
      );
    }
  }
  return output;
}

async function exportConversation(
  ctx: ExportContext,
  plan: BundlePlan,
  root: Record<string, unknown>,
  store: ArtifactStore,
  toolRefs: ReadonlyMap<string, ToolReference>,
  stats: BundleExportStats,
): Promise<void> {
  const path = join(plan.stagingDir, 'conversation.jsonl');
  if (plan.identity.kind !== 'coder') {
    atomicWriteFile(path, '');
    return;
  }
  const stubs = rowsForPlan(ctx.relational, plan, 'coder_messages')
    .sort((left, right) => left.legacyRowId - right.legacyRowId);
  const sourceMessages = stubs.map((stub) => {
    const row = fullRow(ctx.db, stub);
    return {
      id: stub.entityUuid,
      role: row.role,
      isMeta: bool(row.is_meta),
      runId: text(row.run_id),
      createdAt: text(row.created_at),
      value: { stub, row },
    } satisfies LegacyConversationMessage<{
      stub: MigratedRowStub;
      row: Record<string, unknown>;
    }>;
  });
  const turns = groupLegacyMessagesIntoTurns(sourceMessages);
  const messageSeqById = new Map(
    stubs.map((stub, index) => [stub.entityUuid, index + 1]),
  );
  const turnIndexByMessageId = new Map<string, number>();
  for (let index = 0; index < turns.length; index += 1) {
    for (const message of turns[index].messages) {
      turnIndexByMessageId.set(message.id, index);
    }
  }
  const toolRefsByTurn = new Map<number, ToolReference[]>();
  for (const ref of toolRefs.values()) {
    const turnIndex =
      (ref.messageId == null
        ? undefined
        : turnIndexByMessageId.get(ref.messageId)) ??
      Math.max(0, turns.length - 1);
    const bucket = toolRefsByTurn.get(turnIndex) ?? [];
    bucket.push(ref);
    toolRefsByTurn.set(turnIndex, bucket);
  }
  const pendingGoalMutations = goalMutation(plan.uuid, root);
  const lines: string[] = [];
  let previousHash: string | null = null;

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const artifactRefs: ArtifactRef[] = [];
    const messages: Array<Record<string, unknown>> = [];
    for (const source of turn.messages) {
      const { stub, row } = source.value;
      const messageRefs: ArtifactRef[] = [];
      let content = parseJson(row.content_json);
      content = replaceToolResults(content, toolRefs, messageRefs);
      content = await extractInlineArtifacts(content, store, messageRefs);
      const messageArtifacts = dedupeArtifacts(messageRefs);
      artifactRefs.push(...messageArtifacts);
      messages.push({
        schema_version: 1,
        id: stub.entityUuid,
        seq: messageSeqById.get(stub.entityUuid)!,
        role: messageRole(row.role),
        content: messageContent(content),
        usage: {
          input_tokens: nonNegativeInteger(row.input_tokens),
          output_tokens: nonNegativeInteger(row.output_tokens),
          cache_read_tokens: nonNegativeInteger(row.cache_read_tokens),
          cache_creation_tokens: nonNegativeInteger(row.cache_creation_tokens),
        },
        is_meta: bool(row.is_meta),
        selected_skill_ids: stringArray(row.selected_skill_ids_json),
        artifact_refs: messageArtifacts,
      });
      stats.counts.coder_messages = (stats.counts.coder_messages ?? 0) + 1;
    }
    const calls = (toolRefsByTurn.get(index) ?? []).map((ref) => {
      artifactRefs.push(...ref.artifacts);
      const associatedSeq =
        (ref.messageId == null ? undefined : messageSeqById.get(ref.messageId)) ??
        (messages.length > 0
          ? Number(messages[messages.length - 1].seq)
          : 1);
      return {
        schema_version: 1,
        id: ref.toolCallId,
        message_seq: associatedSeq,
        tool_use_id: ref.callId,
        tool_name: ref.toolName,
        args: ref.args,
        is_error: ref.isError,
        duration_ms: ref.durationMs,
        nested: ref.nested,
        output: ref.output,
        metadata: ref.metadata,
      };
    });
    const payloadBody = {
      schema_version: 1,
      type: 'coder.turn',
      request_key: '',
      messages,
      message_patches: [],
      tool_calls: calls,
      goal_mutations: index === 0 ? pendingGoalMutations : [],
    };
    const requestKey = createHash('sha256')
      .update(canonicalJson({ ...payloadBody, request_key: undefined }))
      .digest('hex');
    const payload = {
      ...payloadBody,
      request_key: requestKey,
    } as JsonValue;
    const artifacts = dedupeArtifacts(artifactRefs);
    const first = turn.messages[0];
    const last = turn.messages[turn.messages.length - 1];
    const unsigned: Omit<ConversationCommit, 'hash'> = {
      schema_version: 1,
      seq: index + 1,
      operation_id: turn.kind === 'legacy_preamble'
        ? `legacy-preamble:${first.id}`
        : `legacy-turn:${first.id}`,
      request_hash: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
      committed_at: last.createdAt ?? first.createdAt ?? new Date().toISOString(),
      prev_hash: previousHash,
      payload,
      artifacts,
    };
    const hash = createHash('sha256').update(canonicalJson(unsigned)).digest('hex');
    const record: ConversationCommit = { ...unsigned, hash };
    lines.push(JSON.stringify(record));
    previousHash = hash;
    if (turn.kind === 'turn') {
      const sum = (key: string): number => turn.messages.reduce(
        (total, message) => total + nonNegativeInteger(message.value.row[key]),
        0,
      );
      stats.turnCount += 1;
      stats.metricToolCalls += calls.length;
      stats.metricUsage.input += sum('input_tokens');
      stats.metricUsage.output += sum('output_tokens');
      stats.metricUsage.cacheRead += sum('cache_read_tokens');
      stats.metricUsage.cacheCreation += sum('cache_creation_tokens');
      atomicWriteJson(
        join(
          plan.stagingDir,
          'metrics',
          'turns',
          `${String(stats.turnCount).padStart(8, '0')}.json`,
        ),
        {
          schema_version: 1,
          turn_seq: index + 1,
          message_seq:
            messageSeqById.get(last.id) ??
            messageSeqById.get(first.id) ??
            1,
          commit_seq: index + 1,
          message_ids: turn.messages.map((message) => message.id),
          turns: 1,
          tool_calls: calls.length,
          usage: {
            input_tokens: sum('input_tokens'),
            output_tokens: sum('output_tokens'),
            cache_read_tokens: sum('cache_read_tokens'),
            cache_creation_tokens: sum('cache_creation_tokens'),
          },
          subagent_usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          created_at: first.createdAt,
          committed_at: last.createdAt ?? first.createdAt,
        },
      );
    }
  }
  if (turns.length === 0 && pendingGoalMutations.length > 0) {
    const payloadBody = {
      schema_version: 1,
      type: 'coder.turn',
      request_key: '',
      messages: [],
      message_patches: [],
      tool_calls: [],
      goal_mutations: pendingGoalMutations,
    };
    const payload = {
      ...payloadBody,
      request_key: createHash('sha256')
        .update(canonicalJson({ ...payloadBody, request_key: undefined }))
        .digest('hex'),
    } as JsonValue;
    const unsigned: Omit<ConversationCommit, 'hash'> = {
      schema_version: 1,
      seq: 1,
      operation_id: `legacy-goal:${plan.uuid}`,
      request_hash: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
      committed_at:
        text(root.goal_updated_at) ??
        text(root.updated_at) ??
        new Date().toISOString(),
      prev_hash: null,
      payload,
      artifacts: [],
    };
    lines.push(JSON.stringify({
      ...unsigned,
      hash: createHash('sha256').update(canonicalJson(unsigned)).digest('hex'),
    } satisfies ConversationCommit));
  }
  atomicWriteFile(path, lines.length > 0 ? `${lines.join('\n')}\n` : '');
}

function legacyFileCandidate(
  ctx: ExportContext,
  plan: BundlePlan,
  value: unknown,
): string | null {
  const path = text(value);
  if (!path) return null;
  const candidates = isAbsolute(path)
    ? [path]
    : [
        ...(plan.projectRoot ? [join(plan.projectRoot, path)] : []),
        join(ctx.dataDir, path),
        path,
      ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const stat = lstatSync(candidate);
    if (stat.isSymbolicLink()) {
      throw new Error(`legacy Design artifact is a symbolic link: ${candidate}`);
    }
    if (stat.isFile()) return candidate;
  }
  return null;
}

function recordUnavailable(
  stats: BundleExportStats,
  legacyRef: string,
  reason: string,
): void {
  stats.unavailable.push({
    kind: 'legacy_artifact_unavailable',
    legacy_ref: legacyRef,
    reason,
  });
}

function copyLegacyQaArtifactDirectory(
  sourceRoot: string,
  stagingRoot: string,
): { fileCount: number; sizeBytes: number } {
  const sourceStat = lstatSync(sourceRoot);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`legacy QA artifact root is a symbolic link: ${sourceRoot}`);
  }
  if (!sourceStat.isDirectory()) {
    throw new Error(`legacy QA artifact root is not a directory: ${sourceRoot}`);
  }

  mkdirSync(stagingRoot, { recursive: true });
  const pending = [{ source: sourceRoot, target: stagingRoot }];
  let fileCount = 0;
  let sizeBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop()!;
    const entries = readdirSync(current.source, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const sourcePath = join(current.source, entry.name);
      const targetPath = join(current.target, entry.name);
      const stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`legacy QA artifact contains a symbolic link: ${sourcePath}`);
      }
      if (stat.isDirectory()) {
        mkdirSync(targetPath, { recursive: true });
        pending.push({ source: sourcePath, target: targetPath });
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`unsupported legacy QA artifact entry: ${sourcePath}`);
      }
      atomicWriteFile(targetPath, readFileSync(sourcePath));
      fileCount += 1;
      sizeBytes += stat.size;
    }
  }

  return { fileCount, sizeBytes };
}

async function externalizeDesignVersionTarball(
  ctx: ExportContext,
  plan: BundlePlan,
  source: Record<string, unknown>,
  store: ArtifactStore,
  stats: BundleExportStats,
): Promise<ArtifactRef | null> {
  const legacyPath = text(source.tarball_path);
  if (!legacyPath) return null;
  const path = legacyFileCandidate(ctx, plan, legacyPath);
  if (!path) {
    recordUnavailable(
      stats,
      legacyPath,
      'legacy Design System tarball payload is missing',
    );
    return null;
  }
  return store.put({
    kind: 'attachment',
    data: readFileSync(path),
    media_type: 'application/gzip',
    logical_name: basename(path),
  });
}

async function externalizeDesignSourceZip(
  ctx: ExportContext,
  plan: BundlePlan,
  sourceRoot: Record<string, unknown>,
  metadata: SessionMetadata,
  store: ArtifactStore,
  stats: BundleExportStats,
): Promise<SessionMetadata> {
  if (plan.identity.kind !== 'design') return metadata;
  const legacyPath = text(sourceRoot.source_zip_path);
  const declaredHash = text(sourceRoot.source_zip_hash)?.toLowerCase() ?? null;
  if (!legacyPath) {
    if (declaredHash) {
      recordUnavailable(
        stats,
        `design_system_sessions:${String(plan.identity.id)}:source_zip:${declaredHash}`,
        'legacy Design System source ZIP has a hash but no persisted path',
      );
    }
    return metadata;
  }
  const path = legacyFileCandidate(ctx, plan, legacyPath);
  if (!path) {
    recordUnavailable(
      stats,
      legacyPath,
      'legacy Design System source ZIP payload is missing',
    );
    return metadata;
  }
  const ref = await store.put({
    kind: 'attachment',
    data: readFileSync(path),
    media_type: 'application/zip',
    logical_name: basename(path) || 'design-source.zip',
  });
  if (declaredHash && declaredHash !== ref.sha256) {
    throw new Error(
      `legacy Design source hash mismatch for session ${String(plan.identity.id)}: `
      + `expected=${declaredHash} actual=${ref.sha256}`,
    );
  }
  const design =
    metadata.metadata.design != null
    && typeof metadata.metadata.design === 'object'
    && !Array.isArray(metadata.metadata.design)
      ? metadata.metadata.design as Record<string, JsonValue>
      : {};
  return {
    ...metadata,
    metadata: {
      ...metadata.metadata,
      design: {
        ...design,
        sourceZipHash: ref.sha256,
        sourceZipRef: ref as unknown as JsonValue,
      },
    },
  };
}

async function exportGenericRows(
  ctx: ExportContext,
  plan: BundlePlan,
  store: ArtifactStore,
  stats: BundleExportStats,
): Promise<void> {
  const skip = new Set([
    rootTable(plan),
    'coder_messages',
    'coder_tool_calls',
    'projects',
  ]);
  const nextSequenceByDirectory = new Map<string, number>();
  for (const [table, allStubs] of ctx.relational.rowsByTable) {
    if (skip.has(table)) continue;
    const stubs = allStubs.filter((row) => row.owner.uuid === plan.uuid);
    for (const stub of stubs) {
      const source = fullRow(ctx.db, stub);
      let migrated = ctx.relational.transformRow(table, source, stub);
      if (plan.identity.kind !== 'design') {
        for (const [key, value] of Object.entries(migrated)) {
          if (key.endsWith('_json') && typeof value === 'string') migrated[key] = parseJson(value);
        }
      }
      migrated = normalizeInterrupted(migrated) as Record<string, unknown>;
      migrated._entity_type = table;
      if (table === 'company_session_envs') {
        migrated = sealCompanyEnvironmentRow(migrated, ctx.sealer);
      }
      if (plan.identity.kind === 'design' && table === 'design_system_versions') {
        migrated.tarball_ref = await externalizeDesignVersionTarball(
          ctx,
          plan,
          source,
          store,
          stats,
        );
      } else {
        migrated = await externalizeSnapshotContent(table, migrated, store);
        const refs: ArtifactRef[] = [];
        migrated = await extractInlineArtifacts(migrated, store, refs) as Record<string, unknown>;
        if (refs.length > 0) migrated.artifacts = dedupeArtifacts(refs);
      }

      if (table === 'company_drive_files' && typeof source.storage_filename === 'string') {
        const scopeKey = String(source.scope_key);
        const sourcePath = join(
          ctx.dataDir,
          'company-drives',
          scopeKey.replace(':', '_'),
          source.storage_filename,
        );
        if (existsSync(sourcePath)) {
          migrated.file = await store.put({
            kind: 'attachment',
            data: readFileSync(sourcePath),
            media_type: text(source.mime) ?? 'application/octet-stream',
            logical_name: text(source.path) ?? source.storage_filename,
          });
        } else {
          const legacyRef = `${scopeKey}/${source.storage_filename}`;
          stats.unavailable.push({
            kind: 'legacy_artifact_unavailable',
            legacy_ref: legacyRef,
            reason: 'legacy Company drive payload is missing',
          });
          migrated.file = {
            type: 'legacy_artifact_unavailable',
            legacy_ref: legacyRef,
          };
        }
      }
      if (table === 'qa_test_runs' && typeof source.report_persisted_path === 'string') {
        const reportPath = source.report_persisted_path;
        migrated.report_persisted_path = null;
        if (existsSync(reportPath)) {
          const relativeArtifactRoot = join(
            'company',
            'qa-artifacts',
            stub.entityUuid,
          );
          const copied = copyLegacyQaArtifactDirectory(
            reportPath,
            join(plan.stagingDir, relativeArtifactRoot),
          );
          migrated.report_persisted_path = join(
            plan.finalDir,
            relativeArtifactRoot,
          );
          migrated.report = {
            type: 'qa_artifact_directory',
            relative_path: relativeArtifactRoot.replace(/\\/g, '/'),
            file_count: copied.fileCount,
            size_bytes: copied.sizeBytes,
          };
        } else if (reportPath) {
          stats.unavailable.push({
            kind: 'legacy_artifact_unavailable',
            legacy_ref: reportPath,
            reason: 'legacy QA report payload is missing',
          });
          migrated.report = {
            type: 'legacy_artifact_unavailable',
            legacy_ref: reportPath,
          };
        }
      }
      if (
        plan.identity.kind === 'sprite'
        && typeof source.file_rel_path === 'string'
        && plan.projectRoot
      ) {
        const productPath = join(plan.projectRoot, '.sprite-studio', source.file_rel_path);
        const projectRelativePath = join('.sprite-studio', source.file_rel_path).replace(/\\/g, '/');
        if (existsSync(productPath)) {
          const bytes = readFileSync(productPath);
          migrated.product_file = {
            project_relative_path: projectRelativePath,
            sha256: sha256Bytes(bytes),
            size_bytes: bytes.length,
          };
        } else {
          stats.unavailable.push({
            kind: 'legacy_artifact_unavailable',
            legacy_ref: projectRelativePath,
            reason: 'Sprite product file is missing from the project',
          });
          migrated.product_file = {
            type: 'legacy_artifact_unavailable',
            legacy_ref: projectRelativePath,
          };
        }
      }

      const relativeDirectory = categoryForTable(plan, table);
      const directory = join(plan.stagingDir, relativeDirectory);
      mkdirSync(directory, { recursive: true });
      const target = join(directory, `${stub.entityUuid}.json`);
      const kind = entityKind(plan, table);
      const data = {
        ...migratedEntityData(
          ctx,
          plan,
          table,
          stub,
          source,
          migrated,
        ),
        ...(plan.identity.kind === 'app_studio'
          && APP_STUDIO_RUNTIME_TABLES.has(table)
          ? {}
          : { _legacy_table: table }),
      };
      const seq = (nextSequenceByDirectory.get(relativeDirectory) ?? 0) + 1;
      nextSequenceByDirectory.set(relativeDirectory, seq);
      const fallbackTimestamp = new Date().toISOString();
      const createdAt = isoTimestamp(
        source.created_at,
        isoTimestamp(source.updated_at, fallbackTimestamp),
      );
      const updatedAt = isoTimestamp(source.updated_at, createdAt);
      if (
        plan.identity.kind === 'company'
        || plan.identity.kind === 'app_studio'
        || plan.identity.kind === 'sprite'
        || plan.identity.kind === 'design'
      ) {
        const relations = plan.identity.kind === 'design'
          ? table === 'design_system_versions'
            ? { design_session: text(migrated.ds_session_id) ?? plan.uuid }
            : table === 'design_system_components'
              ? { version: text(migrated.version_id) ?? '' }
              : entityRelations(data)
          : entityRelations(data);
        atomicWriteJson(target, {
          schemaVersion: 1,
          id: stub.entityUuid,
          kind: `${
            plan.identity.kind === 'app_studio'
              ? 'app_studio_'
              : plan.identity.kind === 'sprite'
              ? 'sprite'
              : plan.identity.kind === 'design'
                ? 'design'
                : 'company'
          }${plan.identity.kind === 'app_studio' ? '' : '.'}${kind}`,
          seq,
          operationId: deterministicUuid(
            `legacy-entity-operation:${table}:${stub.entityUuid}`,
          ),
          createdAt,
          updatedAt,
          relations,
          data,
          ...(plan.identity.kind === 'app_studio'
            && APP_STUDIO_RUNTIME_TABLES.has(table)
            ? { _entity_type: table }
            : {}),
        });
      } else {
        const operationId = `legacy-entity:${table}:${stub.entityUuid}`;
        const operationHash = createHash('sha256')
          .update(canonicalJson({ kind, data }))
          .digest('hex');
        atomicWriteJson(target, {
          schema_version: 1,
          id: stub.entityUuid,
          seq,
          kind,
          revision: 1,
          operation_id: operationId,
          operation_hash: operationHash,
          created_at: createdAt,
          updated_at: updatedAt,
          deleted_at: null,
          operation_history: [
            {
              operation_id: operationId,
              operation_hash: operationHash,
              revision: 1,
            },
          ],
          data,
        });
      }
      if (table === 'company_session_envs' && migrated.is_secret) {
        protectSecretPath(target);
      }
      stats.counts[table] = (stats.counts[table] ?? 0) + 1;
    }
  }
}

function copySideFile(
  source: string,
  target: string,
): { kind: 'legacy_side_file'; relative_path: string; sha256: string; size: number } {
  const bytes = readFileSync(source);
  atomicWriteFile(target, bytes);
  return {
    kind: 'legacy_side_file',
    relative_path: target.replace(/\\/g, '/'),
    sha256: sha256Bytes(bytes),
    size: bytes.length,
  };
}

async function exportLegacySideFiles(
  ctx: ExportContext,
  plan: BundlePlan,
  store: ArtifactStore,
  stats: BundleExportStats,
): Promise<void> {
  if (plan.identity.kind === 'coder') {
    const legacyId = String(plan.identity.id);
    const transcriptBase = process.env.MCP_SUBAGENT_TRANSCRIPT_DIR?.trim()
      || join(ctx.dataDir, 'subagent-transcripts');
    const transcriptDir = join(transcriptBase, legacyId);
    if (existsSync(transcriptDir)) {
      const records: Array<Record<string, unknown>> = [];
      for (const entry of readdirSync(transcriptDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const bytes = readFileSync(join(transcriptDir, entry.name));
        const ref = await store.put({
          kind: 'attachment',
          data: bytes,
          media_type: entry.name.endsWith('.jsonl') ? 'application/x-ndjson' : 'application/octet-stream',
          logical_name: entry.name,
        });
        records.push({ source_name: entry.name, artifact: ref });
      }
      if (records.length > 0) {
        atomicWriteJson(join(plan.stagingDir, 'subagents', 'transcripts.json'), {
          schema_version: 1,
          records,
        });
      }
    }

    const runtimeDir = join(process.cwd(), '.mcp-indexer', 'runtime-event-logs', 'coder');
    if (existsSync(runtimeDir)) {
      const records: Array<Record<string, unknown>> = [];
      const matcher = new RegExp(`^${legacyId}(?:\\.\\d+)?\\.jsonl$`);
      for (const entry of readdirSync(runtimeDir, { withFileTypes: true })) {
        if (!entry.isFile() || !matcher.test(entry.name)) continue;
        const source = join(runtimeDir, entry.name);
        const target = join(plan.stagingDir, 'events', 'runtime', entry.name);
        const copied = copySideFile(source, target);
        copied.relative_path = `events/runtime/${entry.name}`;
        records.push(copied);
      }
      if (records.length > 0) {
        atomicWriteJson(join(plan.stagingDir, 'events', 'runtime', 'index.json'), {
          schema_version: 1,
          records,
        });
      }
    }
  }

  if (plan.identity.kind === 'company') {
    const archive = join(
      legacySandboxArchiveDir(ctx.dataDir),
      `${String(plan.identity.id)}.tar`,
    );
    if (existsSync(archive)) {
      const bytes = readFileSync(archive);
      atomicWriteFile(
        join(
          plan.stagingDir,
          'checkpoints',
          'sandbox',
          'workdir.tar',
        ),
        bytes,
      );
      atomicWriteJson(join(
        plan.stagingDir,
        'checkpoints',
        'sandbox',
        'archive.json',
      ), {
        schema_version: 1,
        sha256: sha256Bytes(bytes),
        size: bytes.byteLength,
        legacy_source: `${String(plan.identity.id)}.tar`,
      });
    }
  }
  void stats;
}

function summaryForBundle(
  _ctx: ExportContext,
  plan: BundlePlan,
  root: Record<string, unknown>,
  stats: BundleExportStats,
): Record<string, unknown> {
  void plan;
  return {
    schema_version: 1,
    updated_at: text(root.updated_at) ?? new Date().toISOString(),
    turns: stats.turnCount,
    tool_calls: stats.metricToolCalls,
    provider_attempts: stats.counts.coder_provider_attempts ?? 0,
    tokens: {
      input: stats.metricUsage.input,
      output: stats.metricUsage.output,
      cache_read: stats.metricUsage.cacheRead,
      cache_creation: stats.metricUsage.cacheCreation,
    },
  };
}

export async function exportBundle(
  ctx: ExportContext,
  plan: BundlePlan,
): Promise<BundleExportStats> {
  const stats: BundleExportStats = {
    counts: {},
    hashes: {},
    unavailable: [],
    turnCount: 0,
    metricToolCalls: 0,
    metricUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    },
  };
  if (existsSync(plan.finalDir)) {
    ctx.logger.info('bundle already committed; resume skips export', { uuid: plan.uuid });
    return stats;
  }

  const root = rootStub(ctx, plan);
  const sourceRoot = fullRow(ctx.db, root);
  const projection = normalizeInterrupted(
    ctx.relational.transformRow(root.table, sourceRoot, root),
  ) as Record<string, unknown>;
  if (
    plan.scope === 'global'
    && typeof sourceRoot.project_id === 'number'
    && ctx.projects.some(
      (project) => Number(project.id) === sourceRoot.project_id && Boolean(project.is_synthetic),
    )
  ) {
    delete projection.project_id;
  }
  let metadata = createMetadata(ctx, plan, sourceRoot);
  const state = createState(ctx, plan, sourceRoot, projection);
  const store = new ArtifactStore({
    bundlePath: plan.stagingDir,
    sessionId: asSessionId(plan.uuid),
  });
  metadata = await externalizeDesignSourceZip(
    ctx,
    plan,
    sourceRoot,
    metadata,
    store,
    stats,
  );
  atomicWriteJson(join(plan.stagingDir, 'session.json'), metadata);
  atomicWriteJson(join(plan.stagingDir, 'state.json'), state);
  if (plan.identity.kind === 'sprite') {
    const createdAt = isoTimestamp(
      sourceRoot.created_at,
      new Date().toISOString(),
    );
    const updatedAt = isoTimestamp(sourceRoot.updated_at, createdAt);
    atomicWriteJson(join(plan.stagingDir, 'sprite', 'project.json'), {
      schemaVersion: 1,
      id: plan.uuid,
      kind: 'sprite.project',
      seq: 1,
      operationId: deterministicUuid(`legacy-sprite-project:${plan.uuid}`),
      createdAt,
      updatedAt,
      relations: {},
      data: {
        name: text(sourceRoot.name ?? sourceRoot.title) ?? 'Sprites',
        status: String(normalizeStatus(sourceRoot.status ?? 'active')),
        style:
          (parseJson(sourceRoot.style_json ?? sourceRoot.style) ?? {}) as JsonValue,
        exportDir: text(sourceRoot.export_dir) ?? 'assets/sprites',
        settings:
          (parseJson(sourceRoot.settings_json ?? sourceRoot.settings) ?? {}) as JsonValue,
      },
    });
  }
  stats.counts[root.table] = 1;

  const toolRefs = await exportToolCalls(ctx, plan, store, stats);
  await exportConversation(ctx, plan, sourceRoot, store, toolRefs, stats);
  await exportGenericRows(ctx, plan, store, stats);
  await exportLegacySideFiles(ctx, plan, store, stats);
  atomicWriteJson(
    join(plan.stagingDir, 'metrics', 'summary.json'),
    summaryForBundle(ctx, plan, sourceRoot, stats),
  );

  const pending = [plan.stagingDir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error(`migration staging contains an unexpected link: ${path}`);
      }
      if (stat.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`unsupported bundle entry: ${path}`);
      const relativePath = relative(plan.stagingDir, path).replace(/\\/g, '/');
      if (
        relativePath === 'migration.json'
        || /(?:^|\/)\.\d+-\d+-[a-f0-9]{8}\.tmp$/i.test(relativePath)
        || /(?:^|\/)\..+\.tmp-\d+-[0-9a-f-]{36}$/i.test(relativePath)
      ) continue;
      stats.hashes[relativePath] = fileHash(path);
    }
  }
  const marker: MigrationFile = {
    format_version: MIGRATION_FORMAT_VERSION,
    layout_version: SESSION_LAYOUT_VERSION,
    source_db_fingerprint: ctx.sourceFingerprint,
    legacy: plan.identity,
    session_uuid: plan.uuid,
    phase: 'staging',
    created_at: new Date().toISOString(),
    counts: stats.counts,
    hashes: stats.hashes,
    unavailable_artifacts: stats.unavailable,
  };
  atomicWriteJson(join(plan.stagingDir, 'migration.json'), marker);
  for (const [table, count] of Object.entries(stats.counts)) {
    ctx.runState.exported_counts[table] = (ctx.runState.exported_counts[table] ?? 0) + count;
  }
  return stats;
}
