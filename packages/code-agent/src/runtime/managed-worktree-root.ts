import { mkdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

/** Validate each existing ancestor before creating its child. A junction at
 * .mcp-indexer must not cause even an empty directory outside the project. */
export async function ensureManagedWorktreeRoot(projectRoot: string): Promise<string> {
  const project = await realpath(projectRoot);
  let parent = project;
  for (const name of ['.mcp-indexer', 'worktrees']) {
    const child = join(parent, name);
    await mkdir(child, { recursive: true });
    const actual = await realpath(child);
    const rel = relative(project, actual);
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
      throw new Error('Managed worktree directory escapes its project');
    }
    parent = actual;
  }
  return parent;
}
