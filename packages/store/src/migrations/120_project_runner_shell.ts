/**
 * Migration 120 — per-project runner shell.
 *
 * Stores the shell id the runner should launch commands with (e.g.
 * 'pwsh', 'git-bash', 'wsl:Ubuntu', 'custom:C:\\...\\bash.exe'). NULL =
 * system default. Resolved to {file,args} at spawn time so a project can
 * run its scripts under bash/cmd/pwsh independently of the terminal.
 */
import type DatabaseConstructor from 'better-sqlite3';
import type { Migration } from './types.js';

type DB = InstanceType<typeof DatabaseConstructor>;

export const projectRunnerShell120: Migration = {
  version: 120,
  name: 'project_runner_shell',
  up: (db: DB): void => {
    db.exec(`ALTER TABLE projects ADD COLUMN runner_shell TEXT;`);
  },
};
