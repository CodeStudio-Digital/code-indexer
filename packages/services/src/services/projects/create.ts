import { existsSync, statSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { Project } from '@mcp/shared/types.js';
import { ProjectError } from './errors.js';

export interface CreateProjectInput {
  name?: string;
  root_path: string;
  description?: string;
  /**
   * Register this folder as a LOOSE ad-hoc global-session attachment (mig 176):
   * hidden from the "Projetos" grid, and IDEMPOTENT — if a project already
   * exists at this path it is returned as-is instead of throwing `conflict`, so
   * the same folder can be re-picked across sessions. The name is auto-suffixed
   * on collision (loose folders are derived, not user-named).
   */
  loose?: boolean;
}

/**
 * Create a project — validates path, derives a default name from the last
 * two path segments when not provided, enforces uniqueness on both path and
 * name. Pure over `CodeIndexDB` + filesystem; throws `ProjectError` instead
 * of returning HTTP-shaped errors so CLI/MCP/HTTP callers can each map as
 * they prefer.
 */
export class CreateProjectService {
  constructor(private readonly db: CodeIndexDB) {}

  execute(input: CreateProjectInput): Project {
    if (!input.root_path || typeof input.root_path !== 'string') {
      throw new ProjectError('invalid_input', 'root_path is required');
    }

    const absPath = resolvePath(input.root_path);
    if (!existsSync(absPath) || !statSync(absPath).isDirectory()) {
      throw new ProjectError('invalid_input', `root_path "${absPath}" is not an existing directory`);
    }

    const existingByPath = this.db.getProjectByPath(absPath);
    if (existingByPath && existingByPath.root_path === absPath) {
      // Loose registration is idempotent: re-picking the same folder reuses the
      // existing row (and (re)marks it loose if it was created as one) instead
      // of failing. A normal create still rejects the duplicate path.
      if (input.loose) {
        if (existingByPath.is_loose) this.db.setProjectLoose(existingByPath.id, true);
        return existingByPath;
      }
      throw new ProjectError('conflict', `root_path "${absPath}" already used by project "${existingByPath.name}"`);
    }

    // Derive default name from the last 2 path segments when omitted.
    let name = (input.name ?? '').trim();
    if (!name) {
      const parts = absPath.replace(/\\/g, '/').split('/').filter(Boolean);
      name = parts.slice(-2).join('/') || basename(absPath) || 'project';
    }

    const existingByName = this.db.getProjectByName(name);
    if (existingByName) {
      // Loose folders are derived (not user-named), so a name clash is just
      // disambiguated with a numeric suffix rather than rejected.
      if (input.loose) {
        name = this.disambiguateName(name);
      } else {
        throw new ProjectError('conflict', `Project name "${name}" already in use`);
      }
    }

    const created = this.db.createProject(name, absPath, input.description);
    if (input.loose) this.db.setProjectLoose(created.id, true);
    return created;
  }

  /** Append " (2)", " (3)", … until the name is free. */
  private disambiguateName(base: string): string {
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base} (${i})`;
      if (!this.db.getProjectByName(candidate)) return candidate;
    }
    return `${base} (${Date.now()})`;
  }
}
