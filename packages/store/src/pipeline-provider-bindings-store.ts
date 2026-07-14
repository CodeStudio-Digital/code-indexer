/**
 * PipelineProviderBindingsStore — admin-managed mapping of which
 * provider+model+config a given pipeline should use for a given role.
 *
 * Schema is owned by migration 080. The hierarchy (session → template →
 * global) is resolved by `PipelineProviderResolver` in `packages/services`.
 *
 * Why this exists: every pipeline introduced by the candidate-pipeline
 * framework needs at least one LLM-backed dependency (embedder, classifier,
 * reranker, scorer_llm). Hard-coding `provider: 'cloudflare'` in code is
 * exactly the kind of decision the admin must control without a redeploy.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export type BindingScopeType = 'global' | 'template' | 'session';

export interface PipelineProviderBinding {
  id: number;
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode: string;
  config: Record<string, unknown>;
  scope_type: BindingScopeType;
  scope_id: number | null;
  enabled: boolean;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface PipelineProviderBindingInput {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  scope_type: BindingScopeType;
  scope_id?: number | null;
  enabled?: boolean;
  priority?: number;
}

export interface PipelineBindingActivationInput {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
  priority?: number;
}

/**
 * One row for {@link PipelineProviderBindingsStore.bulkApplyProfile} — a
 * single (pipeline, role) target the guided-setup wizard wants bound at
 * GLOBAL scope, carrying its OWN per-role config.
 */
export interface PipelineProfileApplyRow {
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode?: string;
  config?: Record<string, unknown>;
}

interface RawRow {
  id: number;
  pipeline_name: string;
  binding_role: string;
  provider_id: string;
  model_id: string;
  model_mode: string;
  config_json: string;
  scope_type: string;
  scope_id: number | null;
  enabled: number;
  priority: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: RawRow): PipelineProviderBinding {
  return {
    id: row.id,
    pipeline_name: row.pipeline_name,
    binding_role: row.binding_role,
    provider_id: row.provider_id,
    model_id: row.model_id,
    model_mode: row.model_mode,
    config: row.config_json ? (JSON.parse(row.config_json) as Record<string, unknown>) : {},
    scope_type: row.scope_type as BindingScopeType,
    scope_id: row.scope_id,
    enabled: row.enabled !== 0,
    priority: row.priority,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class PipelineProviderBindingsStore {
  constructor(private db: DB) {}

  list(opts: { pipelineName?: string; scopeType?: BindingScopeType; scopeId?: number | null; enabledOnly?: boolean } = {}): PipelineProviderBinding[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.pipelineName) { where.push('pipeline_name = @pipelineName'); params.pipelineName = opts.pipelineName; }
    if (opts.scopeType)    { where.push('scope_type = @scopeType');       params.scopeType = opts.scopeType; }
    if (opts.scopeId != null) { where.push('scope_id = @scopeId');        params.scopeId = opts.scopeId; }
    if (opts.enabledOnly)  { where.push('enabled = 1'); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_provider_bindings ${whereSql}
         ORDER BY pipeline_name, binding_role, scope_type, priority DESC, id`,
      )
      .all(params) as RawRow[];
    return rows.map(mapRow);
  }

  get(id: number): PipelineProviderBinding | null {
    const row = this.db
      .prepare('SELECT * FROM pipeline_provider_bindings WHERE id = ?')
      .get(id) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Resolve the active binding for a given pipeline+role at a given scope.
   * Returns the highest-priority enabled binding within the requested scope.
   * Hierarchical lookup (session → template → global) is the resolver's job —
   * this method only answers "what's bound at THIS scope?".
   */
  findActiveAtScope(opts: {
    pipelineName: string;
    bindingRole: string;
    scopeType: BindingScopeType;
    scopeId: number | null;
  }): PipelineProviderBinding | null {
    const row = this.db
      .prepare(
        `SELECT * FROM pipeline_provider_bindings
         WHERE pipeline_name = @pipelineName
           AND binding_role  = @bindingRole
           AND scope_type    = @scopeType
           AND (scope_id IS @scopeId OR scope_id = @scopeId)
           AND enabled = 1
         ORDER BY priority DESC, id ASC
         LIMIT 1`,
      )
      .get({
        pipelineName: opts.pipelineName,
        bindingRole: opts.bindingRole,
        scopeType: opts.scopeType,
        scopeId: opts.scopeId,
      }) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Like {@link findActiveAtScope} but returns EVERY enabled binding at the
   * requested scope, ordered `priority DESC, id ASC` — i.e. the same order in
   * which they should be tried when the higher-priority one fails at runtime.
   * The failover chain is built by `PipelineProviderResolver.resolveChain`,
   * which picks the first scope that yields ≥1 usable binding and hands the
   * whole ordered list to the caller. This method only answers "what's bound
   * at THIS scope, best-first?".
   */
  findAllActiveAtScope(opts: {
    pipelineName: string;
    bindingRole: string;
    scopeType: BindingScopeType;
    scopeId: number | null;
  }): PipelineProviderBinding[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pipeline_provider_bindings
         WHERE pipeline_name = @pipelineName
           AND binding_role  = @bindingRole
           AND scope_type    = @scopeType
           AND (scope_id IS @scopeId OR scope_id = @scopeId)
           AND enabled = 1
         ORDER BY priority DESC, id ASC`,
      )
      .all({
        pipelineName: opts.pipelineName,
        bindingRole: opts.bindingRole,
        scopeType: opts.scopeType,
        scopeId: opts.scopeId,
      }) as RawRow[];
    return rows.map(mapRow);
  }

  upsert(input: PipelineProviderBindingInput): number {
    const existing = this.db
      .prepare(
        `SELECT id FROM pipeline_provider_bindings
         WHERE pipeline_name = @pipeline_name
           AND binding_role  = @binding_role
           AND scope_type    = @scope_type
           AND (scope_id IS @scope_id OR scope_id = @scope_id)
           AND provider_id   = @provider_id
           AND model_id      = @model_id
           AND model_mode    = @model_mode`,
      )
      .get({
        pipeline_name: input.pipeline_name,
        binding_role:  input.binding_role,
        scope_type:    input.scope_type,
        scope_id:      input.scope_id ?? null,
        provider_id:   input.provider_id,
        model_id:      input.model_id,
        model_mode:    input.model_mode ?? '',
      }) as { id: number } | undefined;

    if (existing) {
      this.db
        .prepare(
          `UPDATE pipeline_provider_bindings
              SET config_json = @config_json,
                  enabled     = @enabled,
                  priority    = @priority,
                  updated_at  = datetime('now')
            WHERE id = @id`,
        )
        .run({
          id: existing.id,
          config_json: JSON.stringify(input.config ?? {}),
          enabled: input.enabled === false ? 0 : 1,
          priority: input.priority ?? 0,
        });
      return existing.id;
    }

    const result = this.db
      .prepare(
        `INSERT INTO pipeline_provider_bindings (
           pipeline_name, binding_role, provider_id, model_id, model_mode,
           config_json, scope_type, scope_id, enabled, priority
         ) VALUES (
           @pipeline_name, @binding_role, @provider_id, @model_id, @model_mode,
           @config_json, @scope_type, @scope_id, @enabled, @priority
         )`,
      )
      .run({
        pipeline_name: input.pipeline_name,
        binding_role:  input.binding_role,
        provider_id:   input.provider_id,
        model_id:      input.model_id,
        model_mode:    input.model_mode ?? '',
        config_json:   JSON.stringify(input.config ?? {}),
        scope_type:    input.scope_type,
        scope_id:      input.scope_id ?? null,
        enabled:       input.enabled === false ? 0 : 1,
        priority:      input.priority ?? 0,
      });
    return Number(result.lastInsertRowid);
  }

  update(id: number, input: PipelineProviderBindingInput): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_provider_bindings
            SET pipeline_name = @pipeline_name,
                binding_role  = @binding_role,
                provider_id   = @provider_id,
                model_id      = @model_id,
                model_mode    = @model_mode,
                config_json   = @config_json,
                scope_type    = @scope_type,
                scope_id      = @scope_id,
                enabled       = @enabled,
                priority      = @priority,
                updated_at    = datetime('now')
          WHERE id = @id`,
      )
      .run({
        id,
        pipeline_name: input.pipeline_name,
        binding_role: input.binding_role,
        provider_id: input.provider_id,
        model_id: input.model_id,
        model_mode: input.model_mode ?? '',
        config_json: JSON.stringify(input.config ?? {}),
        scope_type: input.scope_type,
        scope_id: input.scope_id ?? null,
        enabled: input.enabled === false ? 0 : 1,
        priority: input.priority ?? 0,
      });
    return Number(result.changes) > 0;
  }

  setEnabled(id: number, enabled: boolean): boolean {
    const result = this.db
      .prepare(
        `UPDATE pipeline_provider_bindings
            SET enabled = ?, updated_at = datetime('now')
          WHERE id = ?`,
      )
      .run(enabled ? 1 : 0, id);
    return Number(result.changes) > 0;
  }

  /**
   * Make one GLOBAL binding the sole active route for a pipeline role while
   * preserving every previous row for audit/manual recovery. Template and
   * session overrides are deliberately outside this operation.
   */
  activateGlobal(input: PipelineBindingActivationInput): { id: number; disabledIds: number[] } {
    const selectOthers = this.db.prepare(
      `SELECT id FROM pipeline_provider_bindings
        WHERE pipeline_name = @pipeline_name
          AND binding_role = @binding_role
          AND scope_type = 'global'
          AND enabled = 1
          AND id <> @selected_id
        ORDER BY id`,
    );
    const disableOthers = this.db.prepare(
      `UPDATE pipeline_provider_bindings
          SET enabled = 0, updated_at = datetime('now')
        WHERE pipeline_name = @pipeline_name
          AND binding_role = @binding_role
          AND scope_type = 'global'
          AND enabled = 1
          AND id <> @selected_id`,
    );
    const run = this.db.transaction((value: PipelineBindingActivationInput) => {
      const id = this.upsert({
        ...value, scope_type: 'global', scope_id: null,
        enabled: true, priority: value.priority ?? 0,
      });
      const params = {
        pipeline_name: value.pipeline_name,
        binding_role: value.binding_role,
        selected_id: id,
      };
      const disabledIds = (selectOthers.all(params) as Array<{ id: number }>).map((row) => row.id);
      disableOthers.run(params);
      return { id, disabledIds };
    });
    return run(input);
  }

  delete(id: number): boolean {
    const result = this.db
      .prepare('DELETE FROM pipeline_provider_bindings WHERE id = ?').run(id);
    return Number(result.changes) > 0;
  }

  /** Distinct pipeline names + roles currently bound — used by the admin UI. */
  listKnownPipelines(): Array<{ pipeline_name: string; binding_role: string; count: number }> {
    return this.db
      .prepare(
        `SELECT pipeline_name, binding_role, COUNT(*) AS count
         FROM pipeline_provider_bindings
         GROUP BY pipeline_name, binding_role
         ORDER BY pipeline_name, binding_role`,
      )
      .all() as Array<{ pipeline_name: string; binding_role: string; count: number }>;
  }

  /**
   * Bulk-delete every binding that matches the given scope filter.
   *
   * Operators use this when they've decided to wipe a previously-configured
   * provider matrix (e.g. moving the org from ZAI to a different vendor)
   * and want a clean slate before re-applying via {@link bulkApply}.
   *
   * Behavior:
   *   - When `scopeType` is omitted, ALL bindings are wiped (any scope).
   *   - When `scopeType='global'`, only global rows are wiped (templates +
   *     session overrides survive). This is the safer default the admin
   *     panel uses.
   *   - When `scopeType='template'|'session'`, you can additionally narrow
   *     to a specific `scopeId`.
   *
   * Wrapped in a transaction — either all matching rows go, or none.
   *
   * @returns Number of rows removed.
   */
  bulkDelete(opts: { scopeType?: BindingScopeType; scopeId?: number | null } = {}): number {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (opts.scopeType) {
      where.push('scope_type = @scopeType');
      params.scopeType = opts.scopeType;
    }
    if (opts.scopeId != null) {
      where.push('scope_id = @scopeId');
      params.scopeId = opts.scopeId;
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const stmt = this.db.prepare(`DELETE FROM pipeline_provider_bindings ${whereSql}`);
    const run = this.db.transaction((p: Record<string, unknown>) => stmt.run(p));
    const result = run(params);
    return Number(result.changes);
  }

  /**
   * Bulk-apply ONE provider+model+config to a list of (pipeline_name,
   * binding_role) targets at the GLOBAL scope.
   *
   * Use case: the operator wants every quality classifier to use the same
   * model, or every embedder to point at the same Cloudflare deployment.
   * The admin panel renders a "Apply to all" button on top of the catalog
   * that fans out to this single transaction.
   *
   * Semantics:
   *   - Targets that already have a global binding with the SAME
   *     (provider_id, model_id, model_mode) get their config + enabled +
   *     priority refreshed (via the same UPSERT path single-row upsert
   *     uses).
   *   - Targets with NO global binding get a fresh row.
   *   - Targets with a global binding to a DIFFERENT provider/model are
   *     NOT touched here — that case is what `bulkDelete` is for. Mixing
   *     "replace" with "preserve" in one call would be surprising; the
   *     UI surfaces it as a two-step workflow.
   *
   * Wrapped in a single transaction.
   *
   * @returns Array of upserted row ids (one per target), in input order.
   */
  bulkApply(input: {
    targets: ReadonlyArray<{ pipeline_name: string; binding_role: string }>;
    provider_id: string;
    model_id: string;
    model_mode?: string;
    config?: Record<string, unknown>;
    scope_type?: BindingScopeType;
    scope_id?: number | null;
    enabled?: boolean;
    priority?: number;
  }): number[] {
    const scope = input.scope_type ?? 'global';
    const scopeId = scope === 'global' ? null : input.scope_id ?? null;
    const txn = this.db.transaction(
      (targets: ReadonlyArray<{ pipeline_name: string; binding_role: string }>) => {
        const ids: number[] = [];
        for (const t of targets) {
          ids.push(
            this.upsert({
              pipeline_name: t.pipeline_name,
              binding_role: t.binding_role,
              provider_id: input.provider_id,
              model_id: input.model_id,
              model_mode: input.model_mode ?? '',
              config: input.config ?? {},
              scope_type: scope,
              scope_id: scopeId,
              enabled: input.enabled !== false,
              priority: input.priority ?? 0,
            }),
          );
        }
        return ids;
      },
    );
    return txn(input.targets);
  }

  /**
   * Apply a guided-setup profile: bind a list of (pipeline, role) targets at
   * GLOBAL scope, each with its OWN config.
   *
   * Unlike {@link bulkApply} (which fans ONE shared config to every target
   * via `upsert`), this does **delete-then-insert per (pipeline, role)**:
   *
   *   - Every existing GLOBAL row for that (pipeline, role) is removed first,
   *     then exactly one fresh row is inserted. This guarantees a single
   *     global binding per role and is **idempotent across re-runs** — the
   *     layperson can redo the wizard with a different model and never end
   *     up with duplicate rows. (`upsert` keys on provider+model+mode, so
   *     switching the model would otherwise leave the old row behind.)
   *   - Each row carries its own `config`, so the wizard can preserve the
   *     catalog's per-role recommended config (classifier max_tokens:256 vs
   *     reviewer max_tokens:4000+json_mode) in a single transaction.
   *
   * Template/session bindings are never touched.
   *
   * @returns The inserted row ids, in input order.
   */
  bulkApplyProfile(rows: ReadonlyArray<PipelineProfileApplyRow>): number[] {
    const del = this.db.prepare(
      `DELETE FROM pipeline_provider_bindings
        WHERE pipeline_name = @pipeline_name
          AND binding_role  = @binding_role
          AND scope_type    = 'global'`,
    );
    const ins = this.db.prepare(
      `INSERT INTO pipeline_provider_bindings (
         pipeline_name, binding_role, provider_id, model_id, model_mode,
         config_json, scope_type, scope_id, enabled, priority
       ) VALUES (
         @pipeline_name, @binding_role, @provider_id, @model_id, @model_mode,
         @config_json, 'global', NULL, 1, 0
       )`,
    );
    const txn = this.db.transaction((items: ReadonlyArray<PipelineProfileApplyRow>) => {
      const ids: number[] = [];
      for (const r of items) {
        del.run({ pipeline_name: r.pipeline_name, binding_role: r.binding_role });
        const result = ins.run({
          pipeline_name: r.pipeline_name,
          binding_role:  r.binding_role,
          provider_id:   r.provider_id,
          model_id:      r.model_id,
          model_mode:    r.model_mode ?? '',
          config_json:   JSON.stringify(r.config ?? {}),
        });
        ids.push(Number(result.lastInsertRowid));
      }
      return ids;
    });
    return txn(rows);
  }
}
