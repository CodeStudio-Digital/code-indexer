/**
 * SpriteJobsStore — append-only generation-job ledger (migration 196).
 *
 * One row per generate/edit/variation/process job: status lifecycle
 * (queued → prompting → generating → postprocess → saving → done | failed |
 * cancelled), the EFFECTIVE provider/model after binding failover, and the
 * per-job cost in USD (freemium metering). Rows outlive their subjects —
 * asset deletion detaches (asset_id → NULL) instead of deleting.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { SpriteGenerationJobRow, SpriteJobKind, SpriteJobStatus } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

const TERMINAL: ReadonlySet<SpriteJobStatus> = new Set(['done', 'failed', 'cancelled']);

interface RawRow {
  id: number; sprite_project_id: number; asset_id: number | null;
  kind: string; status: string; user_intent: string | null;
  expanded_prompt: string | null; request_json: string | null;
  provider_id: string | null; model_id: string | null;
  cost_usd: number | null; error: string | null;
  result_version_id: number | null;
  started_at: string | null; finished_at: string | null; created_at: string;
}

function mapRow(r: RawRow): SpriteGenerationJobRow {
  return {
    id: r.id, sprite_project_id: r.sprite_project_id, asset_id: r.asset_id,
    kind: r.kind as SpriteJobKind, status: r.status as SpriteJobStatus,
    user_intent: r.user_intent, expanded_prompt: r.expanded_prompt,
    request: r.request_json ? (JSON.parse(r.request_json) as Record<string, unknown>) : null,
    provider_id: r.provider_id, model_id: r.model_id,
    cost_usd: r.cost_usd, error: r.error,
    result_version_id: r.result_version_id,
    started_at: r.started_at, finished_at: r.finished_at, created_at: r.created_at,
  };
}

export interface SpriteJobInsertInput {
  sprite_project_id: number;
  asset_id?: number | null;
  kind: SpriteJobKind;
  user_intent?: string | null;
  request?: Record<string, unknown> | null;
  provider_id?: string | null;
  model_id?: string | null;
}

export interface SpriteJobResultInput {
  result_version_id?: number | null;
  expanded_prompt?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  cost_usd?: number | null;
}

export class SpriteJobsStore {
  constructor(private db: DB) {}

  insert(input: SpriteJobInsertInput): SpriteGenerationJobRow {
    const result = this.db
      .prepare(
        `INSERT INTO sprite_generation_jobs (
           sprite_project_id, asset_id, kind, user_intent, request_json, provider_id, model_id
         ) VALUES (
           @sprite_project_id, @asset_id, @kind, @user_intent, @request_json, @provider_id, @model_id
         )`,
      )
      .run({
        sprite_project_id: input.sprite_project_id,
        asset_id: input.asset_id ?? null,
        kind: input.kind,
        user_intent: input.user_intent ?? null,
        request_json: input.request != null ? JSON.stringify(input.request) : null,
        provider_id: input.provider_id ?? null,
        model_id: input.model_id ?? null,
      });
    return this.get(Number(result.lastInsertRowid)) as SpriteGenerationJobRow;
  }

  get(id: number): SpriteGenerationJobRow | null {
    const row = this.db.prepare('SELECT * FROM sprite_generation_jobs WHERE id = ?').get(id) as RawRow | undefined;
    return row ? mapRow(row) : null;
  }

  /**
   * Move the job to `status`. Stamps `started_at` the first time the job
   * leaves 'queued' and `finished_at` on the first terminal status; both
   * stamps stick (COALESCE) so re-entrant updates can't rewrite history.
   */
  updateStatus(id: number, status: SpriteJobStatus): boolean {
    const result = this.db
      .prepare(
        `UPDATE sprite_generation_jobs
            SET status = @status,
                started_at = CASE
                  WHEN started_at IS NULL AND @status != 'queued' THEN datetime('now')
                  ELSE started_at END,
                finished_at = CASE
                  WHEN @isTerminal = 1 THEN COALESCE(finished_at, datetime('now'))
                  ELSE finished_at END
          WHERE id = @id`,
      )
      .run({ id, status, isTerminal: TERMINAL.has(status) ? 1 : 0 });
    return Number(result.changes) > 0;
  }

  /**
   * Record result columns as the runner learns them (effective provider /
   * model post-failover, cost, expanded prompt, resulting version). Status
   * transitions are updateStatus's job — this never touches them.
   */
  setResult(id: number, input: SpriteJobResultInput): boolean {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (input.result_version_id !== undefined) { sets.push('result_version_id = @rv'); params.rv = input.result_version_id; }
    if (input.expanded_prompt !== undefined)   { sets.push('expanded_prompt = @ep');   params.ep = input.expanded_prompt; }
    if (input.provider_id !== undefined)       { sets.push('provider_id = @pid');      params.pid = input.provider_id; }
    if (input.model_id !== undefined)          { sets.push('model_id = @mid');         params.mid = input.model_id; }
    if (input.cost_usd !== undefined)          { sets.push('cost_usd = @cost');        params.cost = input.cost_usd; }
    if (sets.length === 0) return false;
    const result = this.db
      .prepare(`UPDATE sprite_generation_jobs SET ${sets.join(', ')} WHERE id = @id`)
      .run(params);
    return Number(result.changes) > 0;
  }

  /** Terminal failure: record the error text and flip to 'failed' with the finished_at stamp. */
  setError(id: number, error: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE sprite_generation_jobs
            SET status = 'failed', error = @error,
                finished_at = COALESCE(finished_at, datetime('now'))
          WHERE id = @id`,
      )
      .run({ id, error });
    return Number(result.changes) > 0;
  }

  listByProject(spriteProjectId: number, limit = 50): SpriteGenerationJobRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sprite_generation_jobs
          WHERE sprite_project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(spriteProjectId, limit) as RawRow[];
    return rows.map(mapRow);
  }

  /** Non-terminal jobs, oldest first (queue recovery scan). Optionally scoped to one sprite project. */
  listActive(spriteProjectId?: number): SpriteGenerationJobRow[] {
    const base = `SELECT * FROM sprite_generation_jobs WHERE status NOT IN ('done','failed','cancelled')`;
    const rows = (spriteProjectId === undefined
      ? this.db.prepare(`${base} ORDER BY created_at ASC, id ASC`).all()
      : this.db.prepare(`${base} AND sprite_project_id = ? ORDER BY created_at ASC, id ASC`).all(spriteProjectId)
    ) as RawRow[];
    return rows.map(mapRow);
  }
}
