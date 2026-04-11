import type DatabaseConstructor from 'better-sqlite3';
type DB = InstanceType<typeof DatabaseConstructor>;

/**
 * Migration 022: Add group_name column to projects table.
 *
 * Allows users to manually assign projects to named groups for
 * organized navigation in the dashboard.
 */
export const projectGroup022 = {
  version: 22,
  name: 'project_group',
  up(db: DB) {
    const cols = db.pragma('table_info(projects)') as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'group_name')) {
      db.exec('ALTER TABLE projects ADD COLUMN group_name TEXT');
    }
  },
};
