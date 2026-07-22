import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { LspServerManager } from '@mcp/services/lsp/lsp-server-manager.js';
import { invalidateAngularWorkspaceForPath } from '@mcp/services/lsp/angular-workspace-index.js';
import { wireAngularWorkspaceRetirement } from '../angular-workspace-retirement.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Angular workspace retirement wiring', () => {
  it('maps watcher metadata changes to the owning project and route family', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-angular-retirement-'));
    roots.push(root);
    const retireRoutes = vi.fn(async () => 1);
    const db = { listProjects: () => [{ id: 17, root_path: root }] } as unknown as CodeIndexDB;
    const manager = { retireRoutes } as unknown as LspServerManager;
    const unsubscribe = wireAngularWorkspaceRetirement(db, manager);

    invalidateAngularWorkspaceForPath(root, join(root, 'package.json'));

    expect(retireRoutes).toHaveBeenCalledWith(
      17,
      'angular-language-server',
      expect.stringMatching(/package\.json$/),
    );
    unsubscribe();
  });
});
