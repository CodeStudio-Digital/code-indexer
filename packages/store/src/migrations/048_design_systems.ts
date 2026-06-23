/**
 * Migration 046 — Design System Creator sessions, versions, components.
 *
 * The Design System Creator is a specialised CompanySession template:
 * the user uploads a zip of HTML/CSS/SCSS theme assets, picks a stack
 * (react-ts, vue-ts, angular), and a roster of subordinates (extractor,
 * components-builder, pages-builder, mcp-builder, docs-writer) turns
 * the zip into a versioned npm package published to the embedded
 * Verdaccio (see migration 047).
 *
 * Schema:
 *   - `design_system_sessions`     — one row per DS session, joined to
 *                                    company_sessions for the multi-agent
 *                                    runtime. Holds the stack choice and
 *                                    `next_bump_hint` (the next semver
 *                                    bump kind chosen by the operator;
 *                                    resets to 'patch' after publish).
 *   - `design_system_versions`     — one row per published / drafted
 *                                    version of the package. `source_hash`
 *                                    is sha256 of the package source tree
 *                                    (excluding node_modules and
 *                                    storybook-static) and is used to
 *                                    skip publishing identical content.
 *   - `design_system_components`   — atomic components & page templates
 *                                    that belong to a published version,
 *                                    so the dashboard can render them.
 *
 * Cascading delete via `company_sessions(id) ON DELETE CASCADE` keeps
 * cleanup atomic when a parent company session is removed.
 */
import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

export const designSystems048 = {
  version: 48,
  name: 'design_systems',
  up(db: DB) {
    db.exec(`
      CREATE TABLE design_system_sessions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        company_session_id  INTEGER NOT NULL
                            REFERENCES company_sessions(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        package_name        TEXT NOT NULL,
        stack               TEXT NOT NULL
                            CHECK(stack IN ('react-ts','vue-ts','angular')),
        source_zip_hash     TEXT,
        source_zip_path     TEXT,
        next_bump_hint      TEXT NOT NULL DEFAULT 'patch'
                            CHECK(next_bump_hint IN ('patch','minor','major')),
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_ds_sessions_company
        ON design_system_sessions(company_session_id);

      CREATE TABLE design_system_versions (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        ds_session_id       INTEGER NOT NULL
                            REFERENCES design_system_sessions(id) ON DELETE CASCADE,
        semver              TEXT NOT NULL,
        bump_kind           TEXT NOT NULL
                            CHECK(bump_kind IN ('initial','patch','minor','major')),
        is_auto_bump        INTEGER NOT NULL DEFAULT 0,
        status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK(status IN ('draft','building','published','failed','skipped')),
        source_hash         TEXT,
        tarball_path        TEXT,
        manifest_json       TEXT,
        mcp_manifest_json   TEXT,
        docs_md             TEXT,
        storybook_path      TEXT,
        error               TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now')),
        published_at        TEXT,
        UNIQUE(ds_session_id, semver)
      );

      CREATE INDEX idx_ds_versions_session
        ON design_system_versions(ds_session_id, created_at DESC);

      CREATE INDEX idx_ds_versions_status
        ON design_system_versions(status, created_at DESC);

      CREATE TABLE design_system_components (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id          INTEGER NOT NULL
                            REFERENCES design_system_versions(id) ON DELETE CASCADE,
        name                TEXT NOT NULL,
        kind                TEXT NOT NULL
                            CHECK(kind IN ('atom','page-template')),
        props_schema_json   TEXT,
        example_code        TEXT,
        created_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_ds_components_version
        ON design_system_components(version_id);

      CREATE INDEX idx_ds_components_kind
        ON design_system_components(kind, name);
    `);
  },
};
