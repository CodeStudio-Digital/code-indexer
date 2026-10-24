import type { OwnedProjectIndexService } from './owned-project-index-types.js';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ServerDeps } from './deps.js';



/** The project and services come from the session's application owner. Never
 * register another project or discover an owner through a TCP port. */
export function createOwnedProjectIndex(deps: Pick<ServerDeps, 'db' | 'projectIndexService' | 'semanticCoordinator'>): OwnedProjectIndexService {
  return new OwnedProjectIndex(deps);
}

class OwnedProjectIndex implements OwnedProjectIndexService {
  constructor(private readonly deps: Pick<ServerDeps, 'db' | 'projectIndexService' | 'semanticCoordinator'>) {}
  async reconcile(projectId: number, input: Record<string, unknown>, control: Parameters<OwnedProjectIndexService['reconcile']>[2]) {
    const deps = this.deps;
    const check = () => { control.signal.throwIfAborted(); control.assertCurrent(); };
    check();
    if (!Number.isSafeInteger(projectId) || projectId <= 0 || typeof input.project_path !== 'string'
      || !input.project_path.trim() || input.project_path.length > 32768 || input.project_path.includes('\0')
      || (input.rebuild_semantic != null && typeof input.rebuild_semantic !== 'boolean')) throw new Error('Invalid project indexing arguments');
    const project = deps.db.getProject(projectId);
    if (!project || project.is_synthetic) throw new Error('Indexing requires a real project owner');
    const roots = await Promise.all([realpath(project.root_path), realpath(resolve(project.root_path, input.project_path))]);
    const normalized = roots.map(root => process.platform === 'win32' ? root.toLowerCase() : root);
    if (normalized[0] !== normalized[1]) throw new Error('Indexing path differs from the owning project');
    check();
    deps.projectIndexService.ensureFresh(projectId, 'manual');
    const readiness = await deps.projectIndexService.ensureStructuralReady(projectId, 180_000, control.signal);
    check();
    if (readiness.status !== 'ready') return `Structural reconciliation is still ${readiness.status}; semantic indexing was not requested. Inspect project index status before continuing.`;
    const job = deps.semanticCoordinator.enqueueCodeProjectReindex(projectId, input.rebuild_semantic === true);
    check();
    return `Structural index is ready. Semantic ${input.rebuild_semantic === true ? 'rebuild' : 'start'} job #${job.id} was accepted by the server-owned worker.`;
  }
}
