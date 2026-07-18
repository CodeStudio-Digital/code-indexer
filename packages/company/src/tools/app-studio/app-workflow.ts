import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoderTool, JsonSchema } from '@mcp/code-agent/core/tool.js';
import { err, ok } from '@mcp/code-agent/core/tool.js';
import { auditAppPlan } from '@mcp/app-studio/plan/fitness.js';
import { appWorkspaceFingerprint } from '@mcp/app-studio/plan/evidence.js';
import { APP_PLAN_SCHEMA } from '@mcp/app-studio/plan/schema.js';
import {
  formatAppPlanValidationIssues,
  parseAppPlan,
  validateAppPlan,
  type AppFitnessReport,
  type AppPlanV1,
} from '@mcp/app-studio/plan/types.js';
import { nextMigrationFilename, normalizeMigrationSlug, validateAppMigrationSql } from '@mcp/app-studio/database/migration.js';
import { replaceAppSeedFile, validateAppSeedSql } from '@mcp/app-studio/database/seed.js';
import { listSqlMigrations, runWorkspaceScript, summarizeOutput } from '@mcp/app-studio/verification/workspace-checks.js';
import { readDbStatus } from '@mcp/app-studio/status-files.js';
import { findLocalD1File } from '@mcp/app-studio/local-db.js';
import { getDatabaseProvisioner } from '@mcp/services/app-studio/index.js';
import type {
  AppStudioSession,
  AppStudioStore,
  AppStudioWorkItem,
  AppStudioWorkItemKind,
} from '@mcp/store/app-studio-store.js';
import { resolveHostPath } from '@mcp/company/tools/design-system/ds-publish-version.js';
import type { AppToolBinding } from './binding.js';
import { getAppStudioStore } from './store-binding.js';
import { appResult } from './model-output.js';
import { ensureAppStudioDbConnection, getAppStudioDbClientStore } from './db-client-bridge.js';
import { dispatchReadyAppWork, type AppCompanyDispatchHost } from './company-dispatch.js';

const EMPTY: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

function json<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

type BoundApp = { ok: false; error: string } | { ok: true; store: AppStudioStore; session: AppStudioSession };
function bound(binding: AppToolBinding): BoundApp {
  const store = getAppStudioStore();
  if (!store) return { ok: false, error: 'AppStudioStore not wired.' };
  const session = binding.resolveAppSession(store);
  return session
    ? { ok: true, store, session }
    : { ok: false, error: `No App is bound to ${binding.describeBinding()}.` };
}

function latestPlan(value: Extract<BoundApp, { ok: true }>) {
  const revision = value.store.getLatestPlanRevision(value.session.id);
  const plan = parseAppPlan(revision?.plan_json ?? null);
  const fitness = json<AppFitnessReport | null>(revision?.fitness_json, null);
  return { revision, plan, fitness };
}

function workView(row: AppStudioWorkItem) {
  return {
    id: row.id,
    plan_revision_id: row.plan_revision_id,
    slice_id: row.slice_id,
    title: row.title,
    outcome: row.outcome,
    kind: row.kind,
    owner_role: row.owner_role,
    priority: row.priority,
    status: row.status,
    depends_on: json<string[]>(row.depends_on_json, []),
    source_ids: json<string[]>(row.source_ids_json, []),
    acceptance: json<string[]>(row.acceptance_json, []),
    evidence: json<Array<Record<string, unknown>>>(row.evidence_json, []),
    file_scope: json<string[]>(row.file_scope_json, []),
    blocked_reason: row.blocked_reason,
  };
}

export function appGetState(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_state',
    description: 'Read the compact App state: plan readiness, human progress, decisions, cards and deployment. This is the authoritative control-plane snapshot.',
    parameters: EMPTY,
    source: 'native', mutates: false, parallelSafe: true, stopOnRepeatedUnchangedResult: true,
    handler: async () => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const { revision, fitness } = latestPlan(value);
      const work = value.store.listWorkItems(value.session.id);
      const decisions = value.store.listDecisions(value.session.id);
      const deployment = value.store.getLatestDeployment(value.session.id);
      const stage = deployment?.status === 'live' && deployment.health_ok
        ? 'live'
        : revision?.status !== 'approved'
          ? 'planning'
          : decisions.some((item) => item.status === 'open') || work.some((item) => ['review', 'blocked'].includes(item.status))
            ? 'reviewing'
            : work.length > 0 && work.every((item) => item.status === 'done') ? 'ready' : 'building';
      return appResult('App state', {
        app: { id: value.session.id, name: value.session.name, stack_profile_id: value.session.stack_profile_id },
        stage,
        plan: revision ? { id: revision.id, revision_number: revision.revision_number, status: revision.status, fitness: fitness?.status ?? 'blocked' } : null,
        work: Object.fromEntries(['backlog', 'ready', 'running', 'review', 'done', 'blocked', 'stale', 'cancelled'].map((status) => [status, work.filter((item) => item.status === status).length])),
        open_decisions: decisions.filter((item) => item.status === 'open').length,
        deployment,
      });
    },
  };
}

export function appGetPlan(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_plan',
    description: 'Read the current canonical AppPlanV1 and its explainable fitness report.',
    parameters: EMPTY,
    source: 'native', outputPolicy: { mode: 'authoritative', reducer: 'none', recovery: 'output_store', preserveOnError: true }, mutates: false, parallelSafe: true, stopOnRepeatedUnchangedResult: true,
    handler: async () => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const { revision, plan, fitness } = latestPlan(value);
      return revision && plan
        ? appResult(`App plan r${revision.revision_number}`, { revision: { id: revision.id, revision_number: revision.revision_number, status: revision.status }, plan, fitness })
        : err('The App has no valid AppPlanV1.');
    },
  };
}

const PLAN_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    plan: { ...APP_PLAN_SCHEMA, description: 'Complete AppPlanV1 document.' },
    expected_revision_number: { type: 'integer', minimum: 1 },
    reason: { type: 'string' },
  },
  required: ['plan', 'reason'],
  additionalProperties: false,
};

export function appUpdatePlan(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_update_plan',
    description: 'Save one complete AppPlanV1 revision. The fitness audit runs automatically and prior cards become stale; this never approves the plan.',
    parameters: PLAN_SCHEMA,
    source: 'native', mutates: true, parallelSafe: false,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      try {
        const validation = validateAppPlan(args.plan);
        if (!validation.ok) return err(formatAppPlanValidationIssues(validation.issues));
        const fitness = auditAppPlan(validation.plan);
        const revision = value.store.savePlanRevision({
          app_session_id: value.session.id,
          plan: validation.plan,
          fitness,
          expected_revision_number: typeof args.expected_revision_number === 'number' ? args.expected_revision_number : null,
          created_by: 'app_orchestrator',
        });
        return appResult(`App plan r${revision.revision_number} saved`, { revision_id: revision.id, fitness, approval_required: true });
      } catch (error) {
        const message = error instanceof Error && !(error instanceof TypeError)
          ? error.message
          : 'App plan processing failed after validation. No revision was saved.';
        return err(message);
      }
    },
  };
}

const UPSERT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', minItems: 1, items: { type: 'object', properties: {
      id: { type: 'string' }, slice_id: { type: ['string', 'null'] }, title: { type: 'string' }, outcome: { type: 'string' },
      kind: { type: 'string', enum: ['research', 'plan', 'contract', 'implement', 'verify', 'release', 'change'] },
      owner_role: { type: 'string' }, priority: { type: 'integer' }, sort_order: { type: 'integer' },
      depends_on: { type: 'array', items: { type: 'string' } }, source_ids: { type: 'array', items: { type: 'string' } },
      acceptance: { type: 'array', items: { type: 'string' } }, file_scope: { type: 'array', items: { type: 'string' } },
    }, required: ['id', 'title', 'kind', 'owner_role', 'source_ids', 'acceptance'], additionalProperties: false } },
  },
  required: ['items'], additionalProperties: false,
};

export function appUpsertWorkItems(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_upsert_work_items',
    description: 'Create or refine cards for the current plan revision. Cards are the only App work source and remain backlog until that exact revision is approved.',
    parameters: UPSERT_SCHEMA,
    source: 'native', mutates: true, parallelSafe: false,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const { revision, plan } = latestPlan(value);
      if (!revision || !plan) return err('Save a valid AppPlanV1 before creating work.');
      const raw = Array.isArray(args.items) ? args.items as Array<Record<string, unknown>> : [];
      if (raw.length === 0) return err('items is required.');
      const ids = raw.map((item) => String(item.id ?? '').trim());
      if (ids.some((id) => !id) || new Set(ids).size !== ids.length) return err('Every item needs a unique non-empty id.');
      const known = new Set([...value.store.listWorkItems(value.session.id).map((item) => item.id), ...ids]);
      for (const item of raw) {
        for (const dep of Array.isArray(item.depends_on) ? item.depends_on.map(String) : []) {
          if (!known.has(dep)) return err(`Unknown dependency '${dep}'.`);
          if (dep === String(item.id)) return err(`Work item '${dep}' cannot depend on itself.`);
        }
      }
      const saved = value.store.upsertWorkItems(raw.map((item, index) => ({
        app_session_id: value.session.id,
        id: String(item.id),
        plan_revision_id: revision.id,
        slice_id: typeof item.slice_id === 'string' ? item.slice_id : null,
        title: String(item.title),
        outcome: typeof item.outcome === 'string' ? item.outcome : '',
        kind: String(item.kind) as AppStudioWorkItemKind,
        owner_role: String(item.owner_role),
        priority: typeof item.priority === 'number' ? item.priority : 0,
        sort_order: typeof item.sort_order === 'number' ? item.sort_order : index,
        status: 'backlog' as const,
        depends_on_json: JSON.stringify(Array.isArray(item.depends_on) ? item.depends_on : []),
        source_ids_json: JSON.stringify(Array.isArray(item.source_ids) ? item.source_ids : []),
        acceptance_json: JSON.stringify(Array.isArray(item.acceptance) ? item.acceptance : []),
        file_scope_json: JSON.stringify(Array.isArray(item.file_scope) ? item.file_scope : []),
      })));
      value.store.refreshReadyWorkItems(value.session.id);
      return appResult('App work updated', { plan_revision_id: revision.id, items: saved.map(workView) });
    },
  };
}

export function appRequestDecision(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_request_decision',
    description: 'Request one durable decision and block only the listed cards. Independent work continues.',
    parameters: { type: 'object', properties: {
      question: { type: 'string' }, options: { type: 'array', items: { type: 'object' } },
      blocked_work_item_ids: { type: 'array', items: { type: 'string' } },
    }, required: ['question', 'blocked_work_item_ids'], additionalProperties: false } as JsonSchema,
    source: 'native', mutates: true,
    handler: async (args) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const { revision } = latestPlan(value);
      const question = typeof args.question === 'string' ? args.question.trim() : '';
      const blocked = Array.isArray(args.blocked_work_item_ids) ? args.blocked_work_item_ids.map(String) : [];
      if (!revision || !question) return err('A current plan and question are required.');
      for (const id of blocked) {
        if (!value.store.getWorkItem(value.session.id, id)) return err(`Unknown work item '${id}'.`);
        value.store.setWorkItemStatus(value.session.id, id, 'blocked', { blockedReason: question });
      }
      const decision = value.store.createDecision({
        sessionId: value.session.id,
        planRevisionId: revision.id,
        question,
        optionsJson: JSON.stringify(args.options ?? []),
        blockedWorkItemIdsJson: JSON.stringify(blocked),
      });
      return ok(`Decision ${decision.id} requested; ${blocked.length} linked card(s) blocked.`);
    },
  };
}

export function appRequestPlanApproval(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_request_plan_approval',
    description: 'Audit the current plan and expose the single human action “Approve plan and build”. This tool never auto-approves.',
    parameters: EMPTY,
    source: 'native', mutates: true,
    handler: async () => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const { revision, plan } = latestPlan(value);
      if (!revision || !plan) return err('The App has no valid plan.');
      const fitness = auditAppPlan(plan);
      if (fitness.status !== 'ready') return appResult('Plan approval blocked', { fitness, action: 'Resolve every failed check.' });
      value.store.appendEvent(value.session.id, 'plan.approval_requested', 'plan_revision', String(revision.id), JSON.stringify({ revision_number: revision.revision_number }), `plan-approval-requested:${revision.id}`);
      return appResult('Plan ready for approval', { revision_id: revision.id, revision_number: revision.revision_number, fitness, human_action: 'approve_plan_and_build' });
    },
  };
}

export function appDispatchReadyWork(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_dispatch_ready_work',
    description: 'Dispatch the first conflict-safe wave through the persistent App Company team. There is no single-session or execute_tasks fallback.',
    parameters: EMPTY,
    source: 'native', mutates: true, parallelSafe: false,
    handler: async (_args, ctx) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      if (ctx.companyContext?.runtimeKind !== 'app_studio' || !ctx.companyContext.isMaster) {
        return err('Only the persistent App Company Master can dispatch App work.');
      }
      if (value.session.company_session_id !== ctx.companyContext.companySessionId) return err('The App is linked to a different Company team.');
      const results = await dispatchReadyAppWork({
        store: value.store,
        session: value.session,
        host: ctx.companyContext.orchestrator as AppCompanyDispatchHost,
        source: 'master_tool',
      });
      return appResult('App team dispatch', { results, legacy_fallback: false });
    },
  };
}

export function appRecordWorkEvidence(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_record_work_evidence',
    description: 'Record concrete evidence for the active specialist attempt. Evidence is bound to the approved plan and current workspace fingerprint.',
    parameters: { type: 'object', properties: {
      work_item_id: { type: 'string' }, status: { type: 'string', enum: ['review', 'done', 'blocked'] },
      summary: { type: 'string' }, evidence: { type: 'array', items: { type: 'object', properties: {
        kind: { type: 'string' }, value: { type: 'string' },
      }, required: ['kind', 'value'], additionalProperties: false } }, blocked_reason: { type: 'string' },
    }, required: ['work_item_id', 'status', 'summary'], additionalProperties: false } as JsonSchema,
    source: 'native', mutates: true,
    handler: async (args, ctx) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const id = String(args.work_item_id ?? '');
      const item = value.store.getWorkItem(value.session.id, id);
      if (!item) return err(`Unknown work item '${id}'.`);
      const approved = value.store.getLatestApprovedPlanRevision(value.session.id);
      if (!approved || approved.id !== item.plan_revision_id) return err('Evidence can only be recorded for the current approved plan revision.');
      const active = value.store.getActiveWorkItemRun(value.session.id, id);
      const company = ctx.companyContext;
      if (!company || company.runtimeKind !== 'app_studio' || company.isMaster || company.companySessionId !== value.session.company_session_id) {
        return err('Evidence must come from the App specialist that owns the active attempt.');
      }
      if (!active?.company_agent_run_id || active.company_agent_run_id !== company.agentRunId || active.role !== company.agentRole) {
        return err('This specialist does not own the active attempt.');
      }
      const status = String(args.status) as 'review' | 'done' | 'blocked';
      const supplied = Array.isArray(args.evidence) ? args.evidence as Array<Record<string, unknown>> : [];
      if (status !== 'blocked' && supplied.length === 0) return err('Concrete evidence is required.');
      const resolved = resolveHostPath('.', ctx);
      if (resolved.kind === 'no-bind-mount') return err(resolved.message);
      const plan = parseAppPlan(approved.plan_json)!;
      const now = new Date().toISOString();
      const records = supplied.map((record) => ({
        kind: String(record.kind ?? ''), value: String(record.value ?? ''), recorded_at: now,
        actor_role: company.agentRole, actor_agent_run_id: company.agentRunId,
        plan_fingerprint: auditAppPlan(plan).plan_fingerprint,
        workspace_fingerprint: appWorkspaceFingerprint(resolved.path),
      }));
      if (records.some((record) => !record.kind.trim() || !record.value.trim())) return err('Every evidence item needs kind and value.');
      if (['implement', 'contract', 'change'].includes(item.kind) && status === 'done') return err('Implementation cards move to review; a separate verify card closes them.');
      const merged = [...json<Array<Record<string, unknown>>>(item.evidence_json, []), ...records];
      const updated = value.store.setWorkItemStatus(value.session.id, id, status, {
        blockedReason: typeof args.blocked_reason === 'string' ? args.blocked_reason : null,
        evidenceJson: JSON.stringify(merged),
      });
      value.store.updateWorkItemRunStatus(active.id, status === 'blocked' ? 'blocked' : 'completed', { statusMessage: String(args.summary) });
      if (updated.kind === 'verify' && updated.status === 'done') {
        for (const dependencyId of json<string[]>(updated.depends_on_json, [])) {
          const dependency = value.store.getWorkItem(value.session.id, dependencyId);
          if (dependency?.status === 'review') value.store.setWorkItemStatus(value.session.id, dependency.id, 'done', {
            evidenceJson: JSON.stringify([...json<unknown[]>(dependency.evidence_json, []), { kind: 'verified-by', value: updated.id, recorded_at: now }]),
          });
        }
      }
      value.store.refreshReadyWorkItems(value.session.id);
      return ok(`Evidence recorded for '${id}'; status=${updated.status}.`);
    },
  };
}

export function appGetDbState(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_get_db_state',
    description: 'Read the real local D1 migration, seed and provisioning state for this App.',
    parameters: EMPTY,
    source: 'native', mutates: false, parallelSafe: true,
    handler: async (_args, ctx) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const resolved = resolveHostPath('.', ctx); if (resolved.kind === 'no-bind-mount') return err(resolved.message);
      const migrations = listSqlMigrations(resolved.path);
      const status = readDbStatus(resolved.path);
      return appResult('App database state', {
        engine: 'd1', migrations, applied: status?.applied ?? [],
        pending: migrations.filter((name) => !status?.applied.includes(name)),
        local_ready: status?.local_ready ?? false, seeded: status?.seeded ?? false,
        database_file: findLocalD1File(resolved.path) ? 'available' : 'missing',
        last_error_phase: status?.last_error_phase ?? null,
      });
    },
  };
}

export function appUpdateDatabase(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_update_database',
    description: 'Safely update the App D1 database: add one validated migration, replace canonical seed data, or provision the local preview. Remote publishing is never performed here.',
    parameters: { type: 'object', properties: {
      operation: { type: 'string', enum: ['add_migration', 'replace_seed', 'provision_local'] },
      name: { type: 'string' }, sql: { type: 'string' }, reason: { type: 'string' },
    }, required: ['operation'], additionalProperties: false } as JsonSchema,
    source: 'native', mutates: true, parallelSafe: false,
    handler: async (args, ctx) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      if (!value.store.getLatestApprovedPlanRevision(value.session.id)) return err('Approve the current plan before changing the database.');
      const resolved = resolveHostPath('.', ctx); if (resolved.kind === 'no-bind-mount') return err(resolved.message);
      const operation = String(args.operation ?? '');
      if (operation === 'add_migration') {
        const name = String(args.name ?? '');
        const sql = String(args.sql ?? '');
        const slug = normalizeMigrationSlug(name);
        const issue = validateAppMigrationSql(sql);
        if (!slug || issue) return err(issue ?? 'A migration name is required.');
        const migrations = listSqlMigrations(resolved.path);
        const status = readDbStatus(resolved.path);
        const pending = migrations.filter((file) => !status?.applied.includes(file));
        if (pending.length > 0) return err(`Provision the existing pending migration(s) first: ${pending.join(', ')}.`);
        const filename = nextMigrationFilename(migrations, name);
        mkdirSync(join(resolved.path, 'migrations'), { recursive: true });
        writeFileSync(join(resolved.path, 'migrations', filename), `${sql.trim()}\n`, 'utf8');
        const stale = value.store.listWorkItems(value.session.id).filter((item) => ['done', 'review'].includes(item.status)).map((item) => item.id);
        value.store.markWorkItemsStale(value.session.id, stale, `Database migration ${filename} changed the implementation evidence.`);
        value.store.appendEvent(value.session.id, 'database.changed', 'migration', filename, JSON.stringify({ operation }));
        return appResult('Database migration added', { filename, stale_work_items: stale });
      }
      if (operation === 'replace_seed') {
        const sql = String(args.sql ?? '');
        const reason = String(args.reason ?? '').trim();
        const issue = validateAppSeedSql(sql);
        if (!reason || issue) return err(issue ?? 'reason is required.');
        const result = replaceAppSeedFile(resolved.path, sql);
        const stale = result.changed
          ? value.store.listWorkItems(value.session.id).filter((item) => ['done', 'review'].includes(item.status)).map((item) => item.id)
          : [];
        value.store.markWorkItemsStale(value.session.id, stale, 'Canonical seed data changed the implementation evidence.');
        value.store.appendEvent(value.session.id, 'database.changed', 'seed', 'seeds/seed.sql', JSON.stringify({ operation, reason, changed: result.changed }));
        return appResult('Database seed updated', { ...result, stale_work_items: stale });
      }
      if (operation === 'provision_local') {
        const outcome = await getDatabaseProvisioner('d1').ensureLocal({ workspaceDir: resolved.path, appSlug: value.session.app_slug, bindingName: 'DB' });
        if (!outcome.ok) return err(outcome.error ?? 'Local D1 provisioning failed.');
        const dbFile = findLocalD1File(resolved.path);
        const dbStore = getAppStudioDbClientStore();
        if (dbFile && dbStore) ensureAppStudioDbConnection(dbStore, value.session, dbFile);
        value.store.appendEvent(value.session.id, 'database.provisioned', 'database', 'local-d1', JSON.stringify({ applied: outcome.applied }));
        return appResult('Local D1 ready', { applied: outcome.applied, database_file: dbFile ? 'available' : 'missing' });
      }
      return err('operation must be add_migration, replace_seed or provision_local.');
    },
  };
}

export function appRunChecks(binding: AppToolBinding): CoderTool {
  return {
    name: 'app_run_checks',
    description: 'Run the explainable plan audit and optionally one declared workspace check before build, review or publish.',
    parameters: { type: 'object', properties: {
      script: { type: 'string', enum: ['test:worker', 'test:e2e', 'build'] },
    }, additionalProperties: false } as JsonSchema,
    source: 'native', mutates: false, parallelSafe: false, riskLevel: 'execute',
    handler: async (args, ctx) => {
      const value = bound(binding); if (!value.ok) return err(value.error);
      const { revision, plan } = latestPlan(value);
      if (!revision || !plan) return err('The App has no valid plan.');
      const fitness = auditAppPlan(plan);
      const script = typeof args.script === 'string' ? args.script : null;
      if (!script) return appResult('App checks', { fitness, script: null });
      const resolved = resolveHostPath('.', ctx); if (resolved.kind === 'no-bind-mount') return err(resolved.message);
      const result = await runWorkspaceScript(resolved.path, script, script === 'test:e2e' ? 180_000 : 120_000);
      return appResult('App checks', {
        fitness,
        script: { name: script, ok: result.ok, output: summarizeOutput(result.output) },
        workspace_fingerprint: appWorkspaceFingerprint(resolved.path),
        ready: fitness.status === 'ready' && result.ok,
      });
    },
  };
}
