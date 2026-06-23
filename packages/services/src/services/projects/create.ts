import { existsSync, statSync } from 'node:fs';
import { basename, resolve as resolvePath } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { Project } from '@mcp/shared/types.js';
import { ProjectError } from './errors.js';

export interface CreateProjectInput {
  name?: string;
  root_path: string;
  description?: string;
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
      throw new ProjectError('conflict', `Project name "${name}" already in use`);
    }

    return this.db.createProject(name, absPath, input.description);
  }
}
