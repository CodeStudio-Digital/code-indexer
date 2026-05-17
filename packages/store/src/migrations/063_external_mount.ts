import type DatabaseConstructor from 'better-sqlite3';

type DB = InstanceType<typeof DatabaseConstructor>;

function hasColumn(db: DB, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function addColumnIfMissing(db: DB, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

function addExternalMountColumns(db: DB, table: string): void {
  try {
    addColumnIfMissing(
      db,
      table,
      'mount_kind',
      "mount_kind TEXT NOT NULL DEFAULT 'owned' CHECK(mount_kind IN ('owned','external'))",
    );
    addColumnIfMissing(
      db,
      table,
      'image_source',
      "image_source TEXT NOT NULL DEFAULT 'default' CHECK(image_source IN ('default','project_dockerfile'))",
    );
    addColumnIfMissing(db, table, 'built_image_tag', 'built_image_tag TEXT');
    addColumnIfMissing(db, table, 'dockerfile_path', 'dockerfile_path TEXT');
    addColumnIfMissing(db, table, 'dockerfile_exposed_port', 'dockerfile_exposed_port INTEGER');
  } catch {
    rebuildWithExternalMountColumns(db, table);
  }
}

function columnExpr(existing: Set<string>, column: string, fallback: string): string {
  return existing.has(column) ? column : fallback;
}

function nullableColumnExpr(existing: Set<string>, column: string): string {
  return columnExpr(existing, column, 'NULL');
}

function defaultedColumnExpr(existing: Set<string>, column: string, fallback: string): string {
  return existing.has(column) ? `COALESCE(${column}, ${fallback})` : fallback;
}

function rebuildWithExternalMountColumns(db: DB, table: string): void {
  if (table === 'company_sandboxes') {
    rebuildCompanySandboxes(db);
    return;
  }
  if (table === 'company_sandbox_services') {
    rebuildCompanySandboxServices(db);
    return;
  }
  throw new Error(`Unsupported external mount migration table: ${table}`);
}

function rebuildCompanySandboxes(db: DB): void {
  const existing = new Set(
    (db.prepare('PRAGMA table_info(company_sandboxes)').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  db.exec(`
    CREATE TABLE company_sandboxes_external_mount_new (
      session_id                INTEGER PRIMARY KEY
                                REFERENCES company_sessions(id) ON DELETE CASCADE,
      container_id              TEXT NOT NULL,
      runtime                   TEXT NOT NULL
                                CHECK(runtime IN ('docker','podman','e2b')),
      stack                     TEXT NOT NULL,
      workdir                   TEXT NOT NULL,
      host_workdir_mount        TEXT,
      host_port                 INTEGER NOT NULL,
      limits_json               TEXT NOT NULL DEFAULT '{}',
      status                    TEXT NOT NULL
                                CHECK(status IN ('provisioning','running','paused',
                                                 'destroying','destroyed','error')),
      error                     TEXT,
      mount_kind                TEXT NOT NULL DEFAULT 'owned'
                                CHECK(mount_kind IN ('owned','external')),
      image_source              TEXT NOT NULL DEFAULT 'default'
                                CHECK(image_source IN ('default','project_dockerfile')),
      built_image_tag           TEXT,
      dockerfile_path           TEXT,
      dockerfile_exposed_port   INTEGER,
      last_access_at_ms         INTEGER NOT NULL,
      paused_at_ms              INTEGER,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT INTO company_sandboxes_external_mount_new (
      session_id, container_id, runtime, stack, workdir, host_workdir_mount,
      host_port, limits_json, status, error, mount_kind, image_source,
      built_image_tag, dockerfile_path, dockerfile_exposed_port,
      last_access_at_ms, paused_at_ms, created_at, updated_at
    )
    SELECT
      session_id,
      container_id,
      runtime,
      stack,
      workdir,
      ${nullableColumnExpr(existing, 'host_workdir_mount')},
      host_port,
      limits_json,
      status,
      error,
      ${defaultedColumnExpr(existing, 'mount_kind', "'owned'")},
      ${defaultedColumnExpr(existing, 'image_source', "'default'")},
      ${nullableColumnExpr(existing, 'built_image_tag')},
      ${nullableColumnExpr(existing, 'dockerfile_path')},
      ${nullableColumnExpr(existing, 'dockerfile_exposed_port')},
      last_access_at_ms,
      paused_at_ms,
      created_at,
      updated_at
    FROM company_sandboxes;

    DROP TABLE company_sandboxes;
    ALTER TABLE company_sandboxes_external_mount_new RENAME TO company_sandboxes;

    CREATE UNIQUE INDEX idx_company_sandboxes_port
      ON company_sandboxes(host_port)
      WHERE status != 'destroyed';

    CREATE UNIQUE INDEX idx_company_sandboxes_container
      ON company_sandboxes(container_id)
      WHERE status != 'destroyed';

    CREATE INDEX idx_company_sandboxes_status
      ON company_sandboxes(status, last_access_at_ms);
  `);
}

function rebuildCompanySandboxServices(db: DB): void {
  const existing = new Set(
    (
      db.prepare('PRAGMA table_info(company_sandbox_services)').all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  db.exec(`
    CREATE TABLE company_sandbox_services_external_mount_new (
      session_id                INTEGER NOT NULL
                                REFERENCES company_sessions(id) ON DELETE CASCADE,
      service_id                TEXT NOT NULL,
      name                      TEXT NOT NULL DEFAULT '',
      container_id              TEXT NOT NULL,
      runtime                   TEXT NOT NULL
                                CHECK(runtime IN ('docker','podman','e2b')),
      stack                     TEXT NOT NULL,
      workdir                   TEXT NOT NULL,
      host_workdir_mount        TEXT,
      host_port                 INTEGER NOT NULL,
      limits_json               TEXT NOT NULL DEFAULT '{}',
      status                    TEXT NOT NULL
                                CHECK(status IN ('provisioning','running','paused',
                                                 'destroying','destroyed','error')),
      error                     TEXT,
      mount_kind                TEXT NOT NULL DEFAULT 'owned'
                                CHECK(mount_kind IN ('owned','external')),
      image_source              TEXT NOT NULL DEFAULT 'default'
                                CHECK(image_source IN ('default','project_dockerfile')),
      built_image_tag           TEXT,
      dockerfile_path           TEXT,
      dockerfile_exposed_port   INTEGER,
      is_primary                INTEGER NOT NULL DEFAULT 0
                                CHECK(is_primary IN (0,1)),
      last_access_at_ms         INTEGER NOT NULL,
      paused_at_ms              INTEGER,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (session_id, service_id)
    );

    INSERT INTO company_sandbox_services_external_mount_new (
      session_id, service_id, name, container_id, runtime, stack, workdir,
      host_workdir_mount, host_port, limits_json, status, error, mount_kind,
      image_source, built_image_tag, dockerfile_path, dockerfile_exposed_port,
      is_primary, last_access_at_ms, paused_at_ms, created_at, updated_at
    )
    SELECT
      session_id,
      service_id,
      name,
      container_id,
      runtime,
      stack,
      workdir,
      ${nullableColumnExpr(existing, 'host_workdir_mount')},
      host_port,
      limits_json,
      status,
      error,
      ${defaultedColumnExpr(existing, 'mount_kind', "'owned'")},
      ${defaultedColumnExpr(existing, 'image_source', "'default'")},
      ${nullableColumnExpr(existing, 'built_image_tag')},
      ${nullableColumnExpr(existing, 'dockerfile_path')},
      ${nullableColumnExpr(existing, 'dockerfile_exposed_port')},
      is_primary,
      last_access_at_ms,
      paused_at_ms,
      created_at,
      updated_at
    FROM company_sandbox_services;

    DROP TABLE company_sandbox_services;
    ALTER TABLE company_sandbox_services_external_mount_new RENAME TO company_sandbox_services;

    CREATE UNIQUE INDEX idx_company_sandbox_services_port
      ON company_sandbox_services(host_port)
      WHERE status != 'destroyed';

    CREATE UNIQUE INDEX idx_company_sandbox_services_container
      ON company_sandbox_services(container_id)
      WHERE status != 'destroyed';

    CREATE UNIQUE INDEX idx_company_sandbox_services_primary
      ON company_sandbox_services(session_id)
      WHERE is_primary = 1 AND status != 'destroyed';

    CREATE INDEX idx_company_sandbox_services_status
      ON company_sandbox_services(status, last_access_at_ms);
  `);
}

export const externalMount063 = {
  version: 63,
  name: 'external_mount',
  up(db: DB) {
    addExternalMountColumns(db, 'company_sandboxes');
    addExternalMountColumns(db, 'company_sandbox_services');
  },
};
