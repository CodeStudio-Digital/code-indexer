import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import type {
  BundlePlan,
  MigrationFile,
  MigrationRunState,
  SqliteDatabase,
} from './model.js';
import {
  MIGRATION_FORMAT_VERSION,
  SESSION_LAYOUT_VERSION,
} from './model.js';
import {
  DELETE_ROW_DISPOSITIONS,
  DROP_TABLES,
  POST_CUT_ROW_GUARDS,
  findForbiddenSessionSchema,
} from './manifest.js';
import { REQUIRED_BUNDLE_DIRECTORIES } from './bundles.js';
import { fileHash, sha256Bytes } from './fs-ops.js';
import { tableColumns, tableExists, tableRowCount } from './db.js';
import {
  calculateSessionMetricsSummary,
  canonicalJson,
  CompanySessionRepository,
  DesignSystemSessionRepository,
  EntityFileRepository,
  SpriteSessionRepository,
  type ArtifactRef,
  type ConversationCommit,
  type SessionMetadata,
} from './session-storage-adapter.js';
import {
  assertProjectDesignSystemLinksUseUuid,
} from './design-system-links.js';

export interface BundleVerification {
  bundlePath: string;
  counts: Record<string, number>;
  artifacts: number;
  unavailableArtifacts: number;
}

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function readUtf8Strict(path: string): string {
  try {
    return strictUtf8Decoder.decode(readFileSync(path));
  } catch (error) {
    throw new Error(`file is not valid UTF-8: ${path}`, { cause: error });
  }
}

function readJsonStrict<T>(path: string): T {
  return JSON.parse(readUtf8Strict(path)) as T;
}

function listFiles(root: string): string[] {
  const output: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`bundle contains a symbolic link: ${path}`);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) output.push(path);
      else throw new Error(`bundle contains unsupported filesystem entry: ${path}`);
    }
  };
  visit(root);
  return output;
}

function assertContained(root: string, candidate: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`artifact path escapes bundle: ${candidate}`);
  }
}

function artifactRefs(value: unknown, output: ArtifactRef[], unavailable: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) artifactRefs(child, output, unavailable);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const row = value as Record<string, unknown>;
  if (
    typeof row.sha256 === 'string'
    && typeof row.relative_path === 'string'
    && (typeof row.size === 'number' || typeof row.size_bytes === 'number')
  ) {
    output.push({
      ...row,
      size: typeof row.size === 'number' ? row.size : row.size_bytes,
    } as unknown as ArtifactRef);
    return;
  }
  if (row.type === 'legacy_artifact_unavailable' && typeof row.legacy_ref === 'string') {
    unavailable.push(row.legacy_ref);
    return;
  }
  for (const child of Object.values(row)) artifactRefs(child, output, unavailable);
}

function verifyArtifact(bundlePath: string, ref: ArtifactRef): void {
  const path = join(bundlePath, ...ref.relative_path.split('/'));
  assertContained(bundlePath, path);
  if (!existsSync(path)) throw new Error(`missing artifact: ${ref.relative_path}`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`artifact is not a safe regular file: ${ref.relative_path}`);
  }
  if (stat.size !== ref.size) {
    throw new Error(`artifact size mismatch: ${ref.relative_path}`);
  }
  if (fileHash(path) !== ref.sha256) {
    throw new Error(`artifact hash mismatch: ${ref.relative_path}`);
  }
}

function parseConversation(path: string): ConversationCommit[] {
  const bytes = readFileSync(path);
  if (bytes.length > 0 && bytes[bytes.length - 1] !== 0x0a) {
    throw new Error(`conversation JSONL has a partial final line: ${path}`);
  }
  let text: string;
  try {
    text = strictUtf8Decoder.decode(bytes);
  } catch (error) {
    throw new Error(`conversation JSONL is not valid UTF-8: ${path}`, { cause: error });
  }
  const lines = text ? text.split('\n').slice(0, -1) : [];
  const records: ConversationCommit[] = [];
  let previousHash: string | null = null;
  const operations = new Set<string>();
  for (let index = 0; index < lines.length; index += 1) {
    const record = JSON.parse(lines[index]) as ConversationCommit;
    if (record.schema_version !== 1 || record.seq !== index + 1) {
      throw new Error(`conversation sequence/schema mismatch at ${path}:${index + 1}`);
    }
    if (record.prev_hash !== previousHash) {
      throw new Error(`conversation previous hash mismatch at ${path}:${index + 1}`);
    }
    if (!record.operation_id || operations.has(record.operation_id)) {
      throw new Error(`conversation duplicate/empty operation id at ${path}:${index + 1}`);
    }
    operations.add(record.operation_id);
    const { hash, ...unsigned } = record;
    const expected = sha256Bytes(canonicalJson(unsigned));
    if (hash !== expected) throw new Error(`conversation hash mismatch at ${path}:${index + 1}`);
    previousHash = hash;
    records.push(record);
  }
  return records;
}

function messagesInCommit(record: ConversationCommit, path: string): readonly unknown[] {
  if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) {
    throw new Error(`conversation commit payload is not an object at ${path}:${record.seq}`);
  }
  const payload = record.payload as Record<string, unknown>;
  if (
    payload.schema_version !== 1 ||
    payload.type !== 'coder.turn' ||
    typeof payload.request_key !== 'string' ||
    !Array.isArray(payload.messages) ||
    !Array.isArray(payload.message_patches) ||
    !Array.isArray(payload.tool_calls) ||
    !Array.isArray(payload.goal_mutations)
  ) {
    throw new Error(`conversation commit is not coder.turn v1 at ${path}:${record.seq}`);
  }
  for (const [index, raw] of payload.messages.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`conversation message is invalid at ${path}:${record.seq}/${index}`);
    }
    const message = raw as Record<string, unknown>;
    if (
      message.schema_version !== 1 ||
      typeof message.id !== 'string' ||
      !Number.isSafeInteger(message.seq) ||
      Number(message.seq) < 1 ||
      !['system', 'user', 'assistant', 'tool'].includes(String(message.role)) ||
      !Array.isArray(message.content) ||
      !Array.isArray(message.selected_skill_ids) ||
      !Array.isArray(message.artifact_refs)
    ) {
      throw new Error(`conversation stored message is invalid at ${path}:${record.seq}/${index}`);
    }
  }
  return payload.messages;
}

export function verifyBundle(
  bundlePath: string,
  expectedUuid?: string,
  sourceFingerprint?: string,
  expectedPhase?: MigrationFile['phase'],
): BundleVerification {
  if (!existsSync(bundlePath)) {
    throw new Error(`bundle directory does not exist: ${bundlePath}`);
  }
  const bundleStat = lstatSync(bundlePath);
  if (bundleStat.isSymbolicLink() || !bundleStat.isDirectory()) {
    throw new Error(`bundle directory is not a safe real directory: ${bundlePath}`);
  }
  for (const directory of REQUIRED_BUNDLE_DIRECTORIES) {
    const path = join(bundlePath, ...directory.split('/'));
    if (!existsSync(path)) {
      throw new Error(`bundle directory missing: ${path}`);
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`bundle directory is not a safe real directory: ${path}`);
    }
  }
  for (const file of [
    'session.json',
    'state.json',
    'conversation.jsonl',
    'metrics/summary.json',
    'migration.json',
  ]) {
    const path = join(bundlePath, file);
    if (!existsSync(path)) throw new Error(`bundle file missing: ${file}`);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`bundle file is not a safe regular file: ${file}`);
    }
  }

  const metadata = readJsonStrict<SessionMetadata>(join(bundlePath, 'session.json'));
  const marker = readJsonStrict<MigrationFile>(join(bundlePath, 'migration.json'));
  if (metadata.schema_version !== SESSION_LAYOUT_VERSION) {
    throw new Error(`unsupported session metadata version at ${bundlePath}`);
  }
  if (expectedUuid && metadata.id !== expectedUuid) {
    throw new Error(`bundle session UUID mismatch at ${bundlePath}`);
  }
  if (marker.format_version !== MIGRATION_FORMAT_VERSION || marker.layout_version !== SESSION_LAYOUT_VERSION) {
    throw new Error(`unsupported migration marker at ${bundlePath}`);
  }
  if (metadata.id !== marker.session_uuid) {
    throw new Error(`session.json/migration.json UUID mismatch at ${bundlePath}`);
  }
  if (sourceFingerprint && marker.source_db_fingerprint !== sourceFingerprint) {
    throw new Error(`bundle belongs to a different source DB: ${bundlePath}`);
  }
  if (expectedPhase && marker.phase !== expectedPhase) {
    throw new Error(
      `bundle migration phase mismatch at ${bundlePath}: expected=${expectedPhase} actual=${marker.phase}`,
    );
  }
  if (marker.phase === 'committed' && !marker.committed_at) {
    throw new Error(`committed bundle has no committed_at timestamp: ${bundlePath}`);
  }

  const bundleFiles = listFiles(bundlePath);
  const relativeFiles = bundleFiles
    .map((path) => relative(bundlePath, path).replace(/\\/g, '/'));
  const temporaryFiles = relativeFiles.filter((name) => (
    /(?:^|\/)\.\d+-\d+-[a-f0-9]{8}\.tmp$/i.test(name)
    || /(?:^|\/)\..+\.tmp-\d+-[0-9a-f-]{36}$/i.test(name)
  ));
  if (temporaryFiles.length > 0) {
    throw new Error(
      `bundle contains orphan atomic temporary files: ${temporaryFiles.join(', ')}`,
    );
  }
  const hashableFiles = relativeFiles
    .filter((name) => (
      name !== 'migration.json'
    ))
    .sort();
  const declaredFiles = Object.keys(marker.hashes).sort();
  if (
    hashableFiles.length !== declaredFiles.length
    || hashableFiles.some((name, index) => name !== declaredFiles[index])
  ) {
    const undeclared = hashableFiles.filter((name) => !marker.hashes[name]);
    const missing = declaredFiles.filter((name) => !hashableFiles.includes(name));
    throw new Error(
      `bundle hash manifest coverage mismatch at ${bundlePath}; `
      + `undeclared=${undeclared.join(',')} missing=${missing.join(',')}`,
    );
  }
  for (const [name, hash] of Object.entries(marker.hashes)) {
    const path = join(bundlePath, ...name.split('/'));
    assertContained(bundlePath, path);
    if (fileHash(path) !== hash) throw new Error(`bundle file hash mismatch: ${path}`);
  }

  const conversationPath = join(bundlePath, 'conversation.jsonl');
  const conversation = parseConversation(conversationPath);
  let highestMessageSeq = 0;
  for (const record of conversation) {
    for (const raw of messagesInCommit(record, conversationPath)) {
      const seq = Number((raw as Record<string, unknown>).seq);
      if (seq <= highestMessageSeq) {
        throw new Error(
          `conversation message seq is not append-only at ${conversationPath}:${record.seq}`,
        );
      }
      highestMessageSeq = seq;
    }
  }
  const actualCounts: Record<string, number> = {
    [rootTableForKind(String(metadata.kind))]: 1,
    coder_messages: conversation.reduce(
      (count, record) => count + messagesInCommit(record, conversationPath).length,
      0,
    ),
  };
  const refs: ArtifactRef[] = [];
  const unavailable: string[] = [];
  for (const record of conversation) artifactRefs(record, refs, unavailable);

  for (const path of bundleFiles) {
    if (!path.endsWith('.json')) continue;
    const value = readJsonStrict<unknown>(path);
    artifactRefs(value, refs, unavailable);
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      const data =
        record.data != null &&
        typeof record.data === 'object' &&
        !Array.isArray(record.data)
          ? (record.data as Record<string, unknown>)
          : null;
      const entityType = record._entity_type ?? data?._legacy_table;
      if (typeof entityType === 'string') {
        actualCounts[entityType] = (actualCounts[entityType] ?? 0) + 1;
      }
    }
  }
  const callsDir = join(bundlePath, 'tools_outputs', 'calls');
  actualCounts.coder_tool_calls = existsSync(callsDir)
    ? readdirSync(callsDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length
    : 0;

  const summaryPath = join(bundlePath, 'metrics', 'summary.json');
  const summary = readJsonStrict<{
    updated_at?: unknown;
    turns?: unknown;
    tool_calls?: unknown;
    provider_attempts?: unknown;
    tokens?: unknown;
  }>(summaryPath);
  if (typeof summary.updated_at !== 'string') {
    throw new Error(`metrics summary has no updated_at: ${summaryPath}`);
  }
  const calculated = calculateSessionMetricsSummary(
    bundlePath,
    summary.updated_at,
  );
  if (canonicalJson(summary) !== canonicalJson(calculated)) {
    throw new Error(`metrics summary does not match immutable records: ${summaryPath}`);
  }

  const uniqueRefs = new Map(
    refs.map((ref) => [`${ref.kind}:${ref.sha256}:${ref.relative_path}`, ref]),
  );
  for (const ref of uniqueRefs.values()) verifyArtifact(bundlePath, ref);
  const undeclaredCounts = Object.entries(actualCounts)
    .filter(([table, count]) => count > 0 && marker.counts[table] == null)
    .map(([table, count]) => `${table}=${count}`);
  if (undeclaredCounts.length > 0) {
    throw new Error(
      `bundle count manifest omits exported rows at ${bundlePath}: ${undeclaredCounts.join(', ')}`,
    );
  }
  for (const [table, expected] of Object.entries(marker.counts)) {
    const actual = actualCounts[table] ?? 0;
    if (actual !== expected) {
      throw new Error(`bundle count mismatch ${bundlePath}: ${table} expected=${expected} actual=${actual}`);
    }
  }
  const markerUnavailable = new Set(marker.unavailable_artifacts.map((item) => item.legacy_ref));
  for (const ref of unavailable) {
    if (!markerUnavailable.has(ref)) {
      throw new Error(`unregistered unavailable artifact ${ref} in ${bundlePath}`);
    }
  }
  return {
    bundlePath,
    counts: marker.counts,
    artifacts: uniqueRefs.size,
    unavailableArtifacts: marker.unavailable_artifacts.length,
  };
}

function rootTableForKind(kind: string): string {
  switch (kind) {
    case 'coder': return 'coder_sessions';
    case 'company': return 'company_sessions';
    case 'app_studio': return 'app_studio_sessions';
    case 'sprite': return 'sprite_projects';
    case 'design': return 'design_system_sessions';
    case 'docs': return 'docs_research_sessions';
    case 'mcp_run': return 'mcp_agent_runs';
    default: throw new Error(`unknown migrated session kind: ${kind}`);
  }
}

export function aggregateBundleCounts(
  plans: readonly BundlePlan[],
  sourceFingerprint: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const plan of plans) {
    const path = existsSync(plan.finalDir) ? plan.finalDir : plan.stagingDir;
    const result = verifyBundle(path, plan.uuid, sourceFingerprint);
    for (const [table, count] of Object.entries(result.counts)) {
      counts[table] = (counts[table] ?? 0) + count;
    }
  }
  return counts;
}

export async function smokeOperationalBundleRepositories(
  plans: readonly BundlePlan[],
): Promise<void> {
  const companyKinds = [
    'boardItem',
    'inboxMessage',
    'kanbanCard',
    'agent',
    'agentRun',
    'masterPrompt',
    'qaRun',
    'service',
    'environment',
    'sandbox',
    'log',
    'appStudioWorkflow',
    'appStudioRun',
    'pipelineRun',
    'workflowStep',
    'deployment',
    'archive',
  ] as const;
  const spriteKinds = [
    'asset',
    'version',
    'job',
    'animation',
    'frame',
  ] as const;
  for (const plan of plans) {
    const bundlePath = existsSync(plan.finalDir)
      ? plan.finalDir
      : plan.stagingDir;
    if (plan.identity.kind === 'app_studio') {
      const appKinds = [
        ['plan-revisions', 'plan_revision'],
        ['work-items', 'work_item'],
        ['work-item-runs', 'work_item_run'],
        ['decisions', 'decision'],
        ['events', 'event'],
        ['deployments', 'deployment'],
      ] as const;
      for (const [namespace, kind] of appKinds) {
        const repository = new EntityFileRepository<object>({
          sessionRoot: bundlePath,
          namespace: `company/app-studio/${namespace}`,
          kind: `app_studio_${kind}`,
        });
        await repository.list({ limit: 1_000 });
      }
      continue;
    }
    if (plan.identity.kind === 'company') {
      const repository = new CompanySessionRepository({
        sessionRoot: bundlePath,
      });
      for (const kind of companyKinds) await repository.list(kind);
      continue;
    }
    if (plan.identity.kind === 'sprite') {
      const repository = new SpriteSessionRepository({
        sessionRoot: bundlePath,
      });
      const project = await repository.getProject(plan.uuid);
      if (!project) {
        throw new Error(`Sprite bundle has no canonical project entity: ${bundlePath}`);
      }
      for (const kind of spriteKinds) await repository.list(kind);
      continue;
    }
    if (plan.identity.kind === 'design') {
      const repository = new DesignSystemSessionRepository({
        sessionRoot: bundlePath,
      });
      const versions = await repository.listVersions();
      for (const version of versions) {
        await repository.listComponents(version.id);
      }
      continue;
    }
    if (plan.identity.kind !== 'coder') continue;
    for (const path of listFiles(bundlePath)) {
      if (!path.endsWith('.json')) continue;
      const record = readJsonStrict<Record<string, unknown>>(path);
      const data =
        record.data != null &&
        typeof record.data === 'object' &&
        !Array.isArray(record.data)
          ? (record.data as Record<string, unknown>)
          : null;
      if (typeof data?._legacy_table !== 'string') continue;
      if (
        record.schema_version !== 1 ||
        typeof record.id !== 'string' ||
        !Number.isSafeInteger(record.seq) ||
        !Number.isSafeInteger(record.revision) ||
        typeof record.kind !== 'string' ||
        typeof record.operation_id !== 'string' ||
        typeof record.operation_hash !== 'string' ||
        !Array.isArray(record.operation_history)
      ) {
        throw new Error(`Coder bundle has an invalid entity envelope: ${path}`);
      }
    }
  }
}

export function assertExportCounts(
  runState: MigrationRunState,
  exportedCounts: Record<string, number>,
): void {
  const mismatches: string[] = [];
  for (const [table, expected] of Object.entries(runState.expected_counts)) {
    if (table === 'projects') continue;
    const actual = exportedCounts[table] ?? 0;
    if (actual !== expected) mismatches.push(`${table}: expected=${expected}, exported=${actual}`);
  }
  if (mismatches.length > 0) {
    throw new Error(`migration row-count verification failed:\n${mismatches.join('\n')}`);
  }
}

export function assertCleanDatabase(db: SqliteDatabase): void {
  const forbiddenPresent = DROP_TABLES.filter((table) => tableExists(db, table));
  if (forbiddenPresent.length > 0) {
    throw new Error(`clean DB still contains forbidden tables: ${forbiddenPresent.join(', ')}`);
  }
  for (const disposition of DELETE_ROW_DISPOSITIONS) {
    if (!tableExists(db, disposition.table)) continue;
    const columns = new Set(tableColumns(db, disposition.table));
    const missingPredicateColumns = (disposition.predicateColumns ?? [])
      .filter((column) => !columns.has(column));
    if (
      missingPredicateColumns.length > 0 &&
      disposition.missingPredicateMeansNoMatch
    ) {
      continue;
    }
    if (missingPredicateColumns.length > 0) {
      throw new Error(
        `cannot verify ${disposition.table} cleanup predicate; missing columns: ${
          missingPredicateColumns.join(', ')
        }`,
      );
    }
    let rows: number;
    try {
      rows = tableRowCount(db, disposition.table, disposition.whereSql);
    } catch (error) {
      if (disposition.dropColumns?.length
        && disposition.dropColumns.every((column) => !columns.has(column))) {
        continue;
      }
      throw error;
    }
    if (rows !== 0) {
      throw new Error(`clean DB still has ${rows} forbidden row(s) in ${disposition.table}`);
    }
  }
  for (const guard of POST_CUT_ROW_GUARDS) {
    if (!tableExists(db, guard.table)) continue;
    const columns = new Set(tableColumns(db, guard.table));
    const missingPredicateColumns = (guard.predicateColumns ?? [])
      .filter((column) => !columns.has(column));
    if (
      missingPredicateColumns.length > 0 &&
      'missingPredicateMeansNoMatch' in guard &&
      guard.missingPredicateMeansNoMatch
    ) {
      continue;
    }
    if (missingPredicateColumns.length > 0) {
      throw new Error(
        `cannot verify ${guard.table} post-cut predicate; missing columns: ${
          missingPredicateColumns.join(', ')
        }`,
      );
    }
    const rows = tableRowCount(db, guard.table, guard.whereSql);
    if (rows !== 0) {
      throw new Error(
        `clean DB still has ${rows} post-cut forbidden row(s) in ${guard.table}`,
      );
    }
  }
  const schema = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  ).all() as Array<{ name: string }>).map((row) => ({
    name: row.name,
    columns: tableColumns(db, row.name),
  }));
  const violations = findForbiddenSessionSchema(schema);
  if (violations.length > 0) throw new Error(`clean DB schema violations:\n${violations.join('\n')}`);
  assertProjectDesignSystemLinksUseUuid(db);
}

export function assertPostCutWriteGuards(db: SqliteDatabase): void {
  const missing: string[] = [];
  for (const guard of POST_CUT_ROW_GUARDS) {
    if (!tableExists(db, guard.table)) continue;
    const columns = new Set(tableColumns(db, guard.table));
    const missingPredicateColumns = (guard.predicateColumns ?? [])
      .filter((column) => !columns.has(column));
    if (
      missingPredicateColumns.length > 0 &&
      'missingPredicateMeansNoMatch' in guard &&
      guard.missingPredicateMeansNoMatch
    ) {
      continue;
    }
    if (missingPredicateColumns.length > 0) {
      missing.push(
        `${guard.table}: predicate columns absent (${missingPredicateColumns.join(', ')})`,
      );
      continue;
    }
    for (const operation of ['insert', 'update'] as const) {
      const name = `session_fs_reject_${guard.table}_${operation}`;
      const trigger = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?`,
      ).get(name);
      if (!trigger) missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(`clean DB is missing post-cut write guards: ${missing.join(', ')}`);
  }
}
