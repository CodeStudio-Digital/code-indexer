/**
 * Idempotent seeder for skills shipped with the MCP server itself
 * (`source = 'builtin'`). Reads every `*.md` under
 * `src/core/coder/skills/builtin/` at boot time, parses the Agent Skills
 * frontmatter, and upserts into `skill_definitions` only when the file's
 * `version` is newer than the existing row — so users who duplicated
 * a builtin to customise it (those rows are stored as `source='user'`
 * with a different id) are never touched.
 *
 * Runs once, synchronously, during http-api boot. Failures log a warning
 * but do NOT crash the server: skills are non-essential at boot and the
 * dashboard surfaces them only when present.
 *
 * Path resolution
 * ───────────────
 * The `.md` files live under `src/core/coder/skills/builtin/`. In `tsx`
 * dev mode `import.meta.url` lands inside `src/`, so a relative `..`
 * walk works directly. In built mode (`tsc` → `dist/`) the same walk
 * lands inside `dist/`, which works ONLY if the `.md` files were copied
 * over by a build step. Until that copy step exists, we fall back to
 * walking up to the project root and reading from `src/`.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSkillMarkdown,
  type SkillFrontmatter,
} from '../coder/skills/agent-skills-parser.js';
import type {
  SkillStore,
  UpsertSkillInput,
  SkillDefinition,
} from '../../store/skill-store.js';
import type { SkillContextMode } from '../coder/skills/types.js';
import { compareSemver } from './semver-compare.js';

/** Result of a single seed pass — used by callers/tests to assert behaviour. */
export interface EnsureBuiltinSkillsResult {
  /** Files inspected (one per `.md`). */
  inspected: number;
  /** Skills inserted because no row existed for the id. */
  inserted: string[];
  /** Skills updated because file's `version` was newer. */
  updated: string[];
  /** Skills skipped because file `version <= existing.version`. */
  skippedSameVersion: string[];
  /** Skills skipped because the existing row is non-builtin (user clone). */
  skippedUserClone: string[];
  /** Files that failed to parse / upsert. Errors are logged, not thrown. */
  failed: Array<{ file: string; error: string }>;
}

/** Locate the `builtin/` directory containing seed `.md` files. */
export function resolveBuiltinSkillsDir(moduleUrl: string): string | null {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    // built mode: dist/core/bootstrap → dist/core/coder/skills/builtin
    join(here, '..', 'coder', 'skills', 'builtin'),
    // dev fallback: walk up to project root, then dive into src/
    ...projectRootCandidates(here).map((root) =>
      join(root, 'src', 'core', 'coder', 'skills', 'builtin'),
    ),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function projectRootCandidates(start: string): string[] {
  const out: string[] = [];
  let dir = start;
  for (let i = 0; i < 8; i++) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

/** Coerce frontmatter values into the `UpsertSkillInput` shape for builtins. */
export function frontmatterToBuiltinUpsert(
  fm: SkillFrontmatter,
  body: string,
  fallbackId: string,
): UpsertSkillInput {
  const id = (typeof fm.name === 'string' && fm.name.trim()) || fallbackId;
  const allowedTools = Array.isArray(fm['allowed-tools'])
    ? (fm['allowed-tools'] as string[])
    : null;
  const tags = Array.isArray(fm.tags) ? (fm.tags as string[]) : ['builtin'];
  const ctxMode = readContextMode(fm['context-mode']);
  const sortOrder = readNumber(fm['sort-order'], 50);
  const triggerPaths = readStringArray((fm.trigger as Record<string, unknown> | undefined)?.paths)
    ?? readStringArray(fm['trigger-paths']);
  const triggerRoles = readStringArray((fm.trigger as Record<string, unknown> | undefined)?.roles)
    ?? readStringArray(fm['trigger-roles']);
  const triggerTags = readStringArray((fm.trigger as Record<string, unknown> | undefined)?.tags)
    ?? readStringArray(fm['trigger-tags']);

  // Trigger tags are stored as `trigger:<tag>` markers in the flat tags
  // column so the matcher can reuse a single field. Builtin tags + trigger
  // tags coexist (e.g. ['builtin','design-system','trigger:design-system']).
  const finalTags = triggerTags
    ? [...tags, ...triggerTags.map((t) => `trigger:${t}`)]
    : tags;

  return {
    id,
    name: id,
    description: typeof fm.description === 'string' ? fm.description : '',
    slash_command: null,
    prompt_body: body,
    scope: 'global',
    enabled: true,
    allowed_tools: allowedTools,
    model_override: null,
    provider_override: null,
    context_mode: ctxMode,
    variables: [],
    sort_order: sortOrder,
    tags: finalTags,
    path_patterns: null,
    trigger_paths: triggerPaths,
    trigger_roles: triggerRoles,
    author: 'mcp-builtin',
    version: typeof fm.version === 'string' ? fm.version : '1.0.0',
    source: 'builtin',
    source_ref: null,
  };
}

function readContextMode(v: unknown): SkillContextMode {
  if (v === 'auto' || v === 'tool' || v === 'both') return v;
  // Legacy: pre-v2 builtins shipped `context-mode: inline`. Migration 054
  // normalises DB rows but file frontmatter is still authored as 'inline'
  // until B7 rewrites them — coerce silently here so older .md files keep
  // working without crashing the seeder.
  if (v === 'inline') return 'auto';
  return 'auto';
}

function readStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v) if (typeof item === 'string' && item.trim()) out.push(item.trim());
  return out.length > 0 ? out : null;
}

function readNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * Decide whether to upsert. Pure for testability.
 * - No existing row → insert.
 * - Existing builtin with older `version` → update.
 * - Existing builtin with same/newer `version` → skip.
 * - Existing non-builtin (user clone) → skip.
 */
export type SeedDecision =
  | { action: 'insert' }
  | { action: 'update' }
  | { action: 'skip-same-version' }
  | { action: 'skip-user-clone' };

export function decideSeed(
  existing: SkillDefinition | null,
  next: UpsertSkillInput,
): SeedDecision {
  if (!existing) return { action: 'insert' };
  if (existing.source !== 'builtin') return { action: 'skip-user-clone' };
  const cmp = compareSemver(next.version ?? '0.0.0', existing.version ?? '0.0.0');
  return cmp > 0 ? { action: 'update' } : { action: 'skip-same-version' };
}

/**
 * Seed all `.md` files in the builtin directory. Idempotent.
 * @param store SkillStore instance, already wired to the active DB.
 * @param opts.builtinDir Override directory (tests).
 * @param opts.logger Override logger (tests).
 */
export function ensureBuiltinSkills(
  store: Pick<SkillStore, 'getSkill' | 'upsertSkill'>,
  opts?: {
    builtinDir?: string;
    logger?: { log: (msg: string) => void; warn: (msg: string) => void };
  },
): EnsureBuiltinSkillsResult {
  const log = opts?.logger ?? { log: console.log, warn: console.warn };
  const result: EnsureBuiltinSkillsResult = {
    inspected: 0,
    inserted: [],
    updated: [],
    skippedSameVersion: [],
    skippedUserClone: [],
    failed: [],
  };

  const dir = opts?.builtinDir ?? resolveBuiltinSkillsDir(import.meta.url);
  if (!dir) {
    log.warn('[builtin-skills] directory not found — nothing to seed');
    return result;
  }

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch (e) {
    log.warn(`[builtin-skills] readdir failed at ${dir}: ${errMsg(e)}`);
    return result;
  }

  for (const file of entries) {
    result.inspected++;
    const filePath = join(dir, file);
    try {
      const raw = readFileSync(filePath, 'utf8');
      const parsed = parseSkillMarkdown(raw, file);
      const fallbackId = file.replace(/\.md$/, '');
      const upsert = frontmatterToBuiltinUpsert(parsed.frontmatter, parsed.body, fallbackId);
      const existing = store.getSkill(upsert.id);
      const decision = decideSeed(existing, upsert);
      switch (decision.action) {
        case 'insert':
          store.upsertSkill(upsert);
          result.inserted.push(upsert.id);
          log.log(`[builtin-skills] seeded "${upsert.id}" v${upsert.version}`);
          break;
        case 'update':
          store.upsertSkill(upsert);
          result.updated.push(upsert.id);
          log.log(
            `[builtin-skills] updated "${upsert.id}" v${existing?.version} → v${upsert.version}`,
          );
          break;
        case 'skip-same-version':
          result.skippedSameVersion.push(upsert.id);
          break;
        case 'skip-user-clone':
          result.skippedUserClone.push(upsert.id);
          log.log(
            `[builtin-skills] preserved user clone "${upsert.id}" (source=${existing?.source})`,
          );
          break;
      }
    } catch (e) {
      const msg = errMsg(e);
      result.failed.push({ file, error: msg });
      log.warn(`[builtin-skills] failed to seed ${file}: ${msg}`);
    }
  }

  return result;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
