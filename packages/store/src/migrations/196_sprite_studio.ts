/**
 * Migration 196 — Sprite Studio (2D sprite production, MVP schema).
 *
 * The Sprite Studio keeps its source of truth INSIDE the game repo
 * (`<root>/.sprite-studio/` — project.json, per-asset asset.json manifests
 * and the immutable v001.png/v002.png version files). These tables are the
 * OPERATIONAL INDEX over those files: a queryable mirror (file_rel_path +
 * content_hash) plus the parts that must never live in the repo — the
 * generation-job ledger with per-job cost (freemium metering) and status.
 * A `resync` operation can rebuild the mirror from the manifests; rows whose
 * file vanished are flipped to status='missing' (hence that status value).
 *
 *   - sprite_projects        → 1 per IDE project (UNIQUE project_id); embeds
 *                              the style profile JSON + export dir
 *   - sprite_assets          → slugged assets (character/prop/tile/...);
 *                              `category` is TEXT without a CHECK on purpose —
 *                              the vocabulary is app-owned and evolves
 *   - sprite_asset_versions  → immutable version files (v%03d.png) with full
 *                              provenance (prompt, params, parent, job)
 *   - sprite_references      → moodboard / character-sheet / palette / pose
 *                              reference images (asset_id NULL = project-wide)
 *   - sprite_generation_jobs → append-only job ledger (status, effective
 *                              provider/model after failover, cost_usd)
 *   - sprite_animations / sprite_frames → phase-2 (animation) schema reserved
 *                              now so F2 needs no migration; a frame POINTS AT
 *                              a version row (version_id) for provenance
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS). FK cascade only fires when
 * PRAGMA foreign_keys is ON, so the stores also delete children explicitly
 * (same caveat as migration 174).
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './index.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const spriteStudio196: Migration = {
  version: 196,
  name: 'sprite_studio',
  up: (db: DB): void => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sprite_projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL UNIQUE,
        name TEXT NOT NULL,
        style_json TEXT NOT NULL DEFAULT '{}',
        export_dir TEXT NOT NULL DEFAULT 'assets/sprites',
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS sprite_assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprite_project_id INTEGER NOT NULL REFERENCES sprite_projects(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        display_name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'misc',    -- app-owned vocabulary (character|enemy|prop|item|tile|...), no CHECK
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',     -- 'draft' | 'approved' | 'archived' | 'missing'
        current_version_id INTEGER,
        anchor_reference_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (sprite_project_id, slug)
      );

      CREATE TABLE IF NOT EXISTS sprite_asset_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES sprite_assets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        file_rel_path TEXT NOT NULL,              -- relative to <root>/.sprite-studio/
        width INTEGER,
        height INTEGER,
        source TEXT NOT NULL DEFAULT 'generated', -- 'generated' | 'edited' | 'processed' | 'imported'
        prompt TEXT,                              -- exact prompt sent to the model (reproducibility)
        user_intent TEXT,                         -- raw user ask, pre style-block expansion
        gen_params_json TEXT,
        parent_version_id INTEGER,
        job_id INTEGER,
        content_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (asset_id, version)
      );

      CREATE TABLE IF NOT EXISTS sprite_references (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprite_project_id INTEGER NOT NULL REFERENCES sprite_projects(id) ON DELETE CASCADE,
        asset_id INTEGER,                         -- NULL = project-wide reference (moodboard)
        kind TEXT NOT NULL DEFAULT 'moodboard',   -- 'moodboard' | 'character_sheet' | 'palette' | 'pose'
        file_rel_path TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sprite_references_project_asset
        ON sprite_references(sprite_project_id, asset_id);

      CREATE TABLE IF NOT EXISTS sprite_generation_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sprite_project_id INTEGER NOT NULL REFERENCES sprite_projects(id) ON DELETE CASCADE,
        asset_id INTEGER,                         -- NULL = job not (yet) tied to an asset
        kind TEXT NOT NULL,                       -- 'generate' | 'edit' | 'variation' | 'process'
        status TEXT NOT NULL DEFAULT 'queued',    -- 'queued'|'prompting'|'generating'|'postprocess'|'saving'|'done'|'failed'|'cancelled'
        user_intent TEXT,
        expanded_prompt TEXT,
        request_json TEXT,
        provider_id TEXT,                         -- effective provider AFTER binding failover
        model_id TEXT,
        cost_usd REAL,
        error TEXT,
        result_version_id INTEGER,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_sprite_generation_jobs_project
        ON sprite_generation_jobs(sprite_project_id, created_at DESC);

      -- ── Phase 2 (animation) — schema reserved now, feature lands later ──
      CREATE TABLE IF NOT EXISTS sprite_animations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL REFERENCES sprite_assets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,                       -- 'walk_S', 'idle', 'custom:*'
        fps INTEGER NOT NULL DEFAULT 8,
        loop_mode TEXT NOT NULL DEFAULT 'loop',   -- 'loop' | 'once' | 'pingpong'
        status TEXT NOT NULL DEFAULT 'draft',
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (asset_id, name)
      );

      CREATE TABLE IF NOT EXISTS sprite_frames (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        animation_id INTEGER NOT NULL REFERENCES sprite_animations(id) ON DELETE CASCADE,
        frame_index INTEGER NOT NULL,
        version_id INTEGER NOT NULL,              -- a frame IS an asset-version row (provenance, per-frame re-roll)
        duration_ms INTEGER,
        UNIQUE (animation_id, frame_index)
      );
    `);
  },
};
