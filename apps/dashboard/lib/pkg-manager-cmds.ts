/**
 * Pure helpers for the per-runtime dependency assistant (project settings):
 * the selectable managers per runtime, the settings key each writes to, and the
 * "update/upgrade" command for a manager. No React/DB — unit-testable.
 *
 * Install commands come from the backend `runner.detect` group (installCommand,
 * which already reflects the chosen manager); only "update" is derived here.
 */

import type { RuntimeKind } from '@mcp/api-bus';
import type { PackageManagerKey } from '@mcp/shared/utils/package-managers.js';

/** The `package_managers` key a runtime writes to ('auto'); PHP/.NET are fixed → none. */
export const MANAGER_KEY: Partial<Record<RuntimeKind, PackageManagerKey>> = {
  node: 'node',
  python: 'python',
  java: 'java',
};

/** Selectable managers per runtime ('auto' = lockfile/manifest detection). */
export const MANAGER_OPTIONS: Record<RuntimeKind, string[]> = {
  node: ['auto', 'npm', 'yarn', 'pnpm', 'bun'],
  python: ['auto', 'pip', 'poetry'],
  php: ['composer'],
  java: ['auto', 'maven', 'gradle'],
  dotnet: ['dotnet'],
};

/** Managers that belong to a runtime — used to pick its detect group. */
export const MANAGERS_FOR_KIND: Record<RuntimeKind, readonly string[]> = {
  node: ['npm', 'yarn', 'pnpm', 'bun'],
  php: ['composer'],
  python: ['pip', 'poetry'],
  java: ['maven', 'gradle'],
  dotnet: ['dotnet'],
};

/** Command to update/upgrade already-installed dependencies for a manager. */
export function updateCommand(manager: string): string {
  switch (manager) {
    case 'yarn': return 'yarn upgrade';
    case 'pnpm': return 'pnpm update';
    case 'bun': return 'bun update';
    case 'composer': return 'composer update';
    case 'pip': return 'pip install --upgrade -r requirements.txt';
    case 'poetry': return 'poetry update';
    case 'maven': return 'mvn -U dependency:resolve';
    case 'gradle': return 'gradle build --refresh-dependencies -x test';
    case 'dotnet': return 'dotnet restore --force';
    default: return 'npm update';
  }
}
