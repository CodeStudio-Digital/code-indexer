/**
 * SkillStore — persists reusable skill definitions.
 *
 * Session selection and usage telemetry live in filesystem session bundles.
 * This store deliberately has no session-scoped table or row API.
 */
import { createRequire } from 'node:module';
import type DatabaseConstructor from 'better-sqlite3';
import type { ResolvedSkill, SkillContextMode, SkillSource } from './skill-types.js';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3') as typeof DatabaseConstructor;
type DB = InstanceType<typeof Database>;

// ─── Public types ────────────────────────────────────────────────

export interface SkillSourceRef {
  repo: string;
  commit: string;
  path: string;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  slash_command: string | null;
  prompt_body: string;
  scope: string;
  enabled: boolean;
  allowed_tools: string[] | null;
  model_override: string | null;
  provider_override: string | null;
  context_mode: SkillContextMode;
  variables: string[];
  sort_order: number;
  tags: string[];
  /** @deprecated legacy column, prefer `trigger_paths`. */
  path_patterns: string[] | null;
  trigger_paths: string[] | null;
  trigger_roles: string[] | null;
  author: string | null;
  version: string;
  source: SkillSource;
  source_ref: SkillSourceRef | null;
  created_at: string;
  updated_at: string;
}

export interface UpsertSkillInput {
  id: string;
  name: string;
  description?: string;
  slash_command?: string | null;
  prompt_body: string;
  scope?: string;
  enabled?: boolean;
  allowed_tools?: string[] | null;
  model_override?: string | null;
  provider_override?: string | null;
  context_mode?: SkillContextMode;
  variables?: string[];
  sort_order?: number;
  tags?: string[];
  /** @deprecated prefer `trigger_paths`. Both columns are written for back-compat. */
  path_patterns?: string[] | null;
  trigger_paths?: string[] | null;
  trigger_roles?: string[] | null;
  author?: string | null;
  version?: string;
  source?: SkillSource;
  source_ref?: SkillSourceRef | null;
}

export interface SkillListFilter {
  scope?: string;
  enabled?: boolean;
  source?: SkillSource;
  tag?: string;
}

// ─── Internal raw row type ───────────────────────────────────────

interface SkillRaw {
  id: string;
  name: string;
  description: string;
  slash_command: string | null;
  prompt_body: string;
  scope: string;
  enabled: number;
  allowed_tools: string | null;
  model_override: string | null;
  provider_override: string | null;
  context_mode: string;
  variables: string;
  sort_order: number;
  tags: string;
  path_patterns: string | null;
  trigger_paths: string | null;
  trigger_roles: string | null;
  author: string | null;
  version: string;
  source: string;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Skill ID: kebab-case, 1-64 chars. */
const SKILL_ID_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

function hydrate(r: SkillRaw): SkillDefinition {
  // Normalize legacy 'inline' → 'auto' on read so old rows that survived
  // migration 054 (e.g. shipped from imported skill packs) still typecheck.
  const ctxMode: SkillContextMode = r.context_mode === 'inline' ? 'auto' : (r.context_mode as SkillContextMode);
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    slash_command: r.slash_command,
    prompt_body: r.prompt_body,
    scope: r.scope,
    enabled: !!r.enabled,
    allowed_tools: parseJson<string[] | null>(r.allowed_tools, null),
    model_override: r.model_override,
    provider_override: r.provider_override,
    context_mode: ctxMode,
    variables: parseJson<string[]>(r.variables, []),
    sort_order: r.sort_order,
    tags: parseJson<string[]>(r.tags, []),
    path_patterns: parseJson<string[] | null>(r.path_patterns, null),
    trigger_paths: parseJson<string[] | null>(r.trigger_paths, null),
    trigger_roles: parseJson<string[] | null>(r.trigger_roles, null),
    author: r.author,
    version: r.version,
    source: r.source as SkillSource,
    source_ref: parseJson<SkillSourceRef | null>(r.source_ref, null),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function toResolved(def: SkillDefinition): ResolvedSkill {
  // Treat tags prefixed with `trigger:` as inline trigger tags (e.g.
  // `trigger:design-system`). This keeps frontmatter terse while letting
  // the matcher reuse a single field.
  const triggerTags = def.tags
    .filter((t) => t.startsWith('trigger:'))
    .map((t) => t.slice('trigger:'.length));
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    slashCommand: def.slash_command,
    promptBody: def.prompt_body,
    allowedTools: def.allowed_tools,
    modelOverride: def.model_override,
    providerOverride: def.provider_override,
    contextMode: def.context_mode,
    pathPatterns: def.path_patterns,
    triggerPaths: def.trigger_paths ?? def.path_patterns,
    triggerRoles: def.trigger_roles,
    triggerTags: triggerTags.length > 0 ? triggerTags : null,
    tags: def.tags,
    source: def.source,
    author: def.author,
    sortOrder: def.sort_order,
  };
}

// ─── Store ───────────────────────────────────────────────────────

export class SkillStore {
  private db: DB;
  private ownsConnection: boolean;

  constructor(dbPathOrInstance: string | DB) {
    if (typeof dbPathOrInstance === 'string') {
      this.db = new Database(dbPathOrInstance);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.ownsConnection = true;
    } else {
      this.db = dbPathOrInstance;
      this.ownsConnection = false;
    }
  }

  close(): void {
    if (this.ownsConnection) this.db.close();
  }

  // ─── CRUD ────────────────────────────────────────────────────

  listSkills(filter?: SkillListFilter): SkillDefinition[] {
    const clauses: string[] = [];
    if (filter?.scope !== undefined) clauses.push(`scope = '${filter.scope}'`);
    if (filter?.enabled !== undefined) clauses.push(`enabled = ${filter.enabled ? 1 : 0}`);
    if (filter?.source !== undefined) clauses.push(`source = '${filter.source}'`);
    if (filter?.tag) clauses.push(`tags LIKE '%"${filter.tag}"%'`);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM skill_definitions ${where} ORDER BY sort_order, name`)
      .all() as SkillRaw[];
    return rows.map(hydrate);
  }

  getSkill(id: string): SkillDefinition | null {
    const row = this.db
      .prepare('SELECT * FROM skill_definitions WHERE id = ?')
      .get(id) as SkillRaw | undefined;
    return row ? hydrate(row) : null;
  }

  getSkillBySlashCommand(cmd: string): SkillDefinition | null {
    const row = this.db
      .prepare('SELECT * FROM skill_definitions WHERE slash_command = ?')
      .get(cmd) as SkillRaw | undefined;
    return row ? hydrate(row) : null;
  }

  upsertSkill(input: UpsertSkillInput): SkillDefinition {
    if (!SKILL_ID_RE.test(input.id)) {
      throw new Error(
        `Invalid skill ID "${input.id}": must be 1-64 lowercase alphanumeric + hyphens`,
      );
    }

    const now = new Date().toISOString();
    const existing = this.getSkill(input.id);

    if (existing) {
      this.db
        .prepare(
          `UPDATE skill_definitions SET
             name = ?, description = ?, slash_command = ?, prompt_body = ?,
             scope = ?, enabled = ?, allowed_tools = ?, model_override = ?,
             provider_override = ?, context_mode = ?, variables = ?,
             sort_order = ?, tags = ?, path_patterns = ?, trigger_paths = ?,
             trigger_roles = ?, author = ?, version = ?, source = ?,
             source_ref = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          input.name,
          input.description ?? existing.description,
          input.slash_command !== undefined ? input.slash_command : existing.slash_command,
          input.prompt_body,
          input.scope ?? existing.scope,
          (input.enabled ?? existing.enabled) ? 1 : 0,
          input.allowed_tools !== undefined ? JSON.stringify(input.allowed_tools) : (existing.allowed_tools ? JSON.stringify(existing.allowed_tools) : null),
          input.model_override !== undefined ? input.model_override : existing.model_override,
          input.provider_override !== undefined ? input.provider_override : existing.provider_override,
          input.context_mode ?? existing.context_mode,
          JSON.stringify(input.variables ?? existing.variables),
          input.sort_order ?? existing.sort_order,
          JSON.stringify(input.tags ?? existing.tags),
          input.path_patterns !== undefined ? JSON.stringify(input.path_patterns) : (existing.path_patterns ? JSON.stringify(existing.path_patterns) : null),
          input.trigger_paths !== undefined ? JSON.stringify(input.trigger_paths) : (existing.trigger_paths ? JSON.stringify(existing.trigger_paths) : null),
          input.trigger_roles !== undefined ? JSON.stringify(input.trigger_roles) : (existing.trigger_roles ? JSON.stringify(existing.trigger_roles) : null),
          input.author !== undefined ? input.author : existing.author,
          input.version ?? existing.version,
          input.source ?? existing.source,
          input.source_ref !== undefined
            ? (input.source_ref ? JSON.stringify(input.source_ref) : null)
            : (existing.source_ref ? JSON.stringify(existing.source_ref) : null),
          now,
          input.id,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO skill_definitions
             (id, name, description, slash_command, prompt_body, scope, enabled,
              allowed_tools, model_override, provider_override, context_mode,
              variables, sort_order, tags, path_patterns, trigger_paths,
              trigger_roles, author, version, source,
              source_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.name,
          input.description ?? '',
          input.slash_command ?? null,
          input.prompt_body,
          input.scope ?? 'global',
          (input.enabled ?? true) ? 1 : 0,
          input.allowed_tools ? JSON.stringify(input.allowed_tools) : null,
          input.model_override ?? null,
          input.provider_override ?? null,
          input.context_mode ?? 'auto',
          JSON.stringify(input.variables ?? []),
          input.sort_order ?? 0,
          JSON.stringify(input.tags ?? []),
          input.path_patterns ? JSON.stringify(input.path_patterns) : null,
          input.trigger_paths ? JSON.stringify(input.trigger_paths) : null,
          input.trigger_roles ? JSON.stringify(input.trigger_roles) : null,
          input.author ?? null,
          input.version ?? '1.0.0',
          input.source ?? 'user',
          input.source_ref ? JSON.stringify(input.source_ref) : null,
          now,
          now,
        );
    }

    return this.getSkill(input.id)!;
  }

  deleteSkill(id: string): void {
    this.db.prepare('DELETE FROM skill_definitions WHERE id = ?').run(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    this.db
      .prepare("UPDATE skill_definitions SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
      .run(enabled ? 1 : 0, id);
  }

  // ─── Import / Export ─────────────────────────────────────────

  exportSkill(id: string): string {
    const skill = this.getSkill(id);
    if (!skill) throw new Error(`Skill "${id}" not found`);
    // Strip timestamps for portable export
    const { created_at: _, updated_at: __, ...portable } = skill;
    return JSON.stringify(portable, null, 2);
  }

  importSkill(json: string, overwrite = false): SkillDefinition {
    const parsed = JSON.parse(json) as Partial<SkillDefinition>;
    if (!parsed.id || !parsed.name || !parsed.prompt_body) {
      throw new Error('Import requires at least: id, name, prompt_body');
    }

    const existing = this.getSkill(parsed.id);
    if (existing && !overwrite) {
      throw new Error(`Skill "${parsed.id}" already exists. Use overwrite=true to replace.`);
    }

    return this.upsertSkill({
      id: parsed.id,
      name: parsed.name,
      description: parsed.description,
      slash_command: parsed.slash_command,
      prompt_body: parsed.prompt_body,
      scope: parsed.scope,
      enabled: parsed.enabled,
      allowed_tools: parsed.allowed_tools,
      model_override: parsed.model_override,
      provider_override: parsed.provider_override,
      context_mode: parsed.context_mode,
      variables: parsed.variables,
      sort_order: parsed.sort_order,
      tags: parsed.tags,
      path_patterns: parsed.path_patterns,
      trigger_paths: parsed.trigger_paths,
      trigger_roles: parsed.trigger_roles,
      author: parsed.author,
      version: parsed.version,
      source: 'imported',
    });
  }
}
