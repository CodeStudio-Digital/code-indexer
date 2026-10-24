import { SemanticConnection } from './semantic-connection.js';
import { SemanticProfiles } from './semantic-profiles.js';
import { SemanticGenerations } from './semantic-generations.js';
import { SemanticItems } from './semantic-items.js';
import { SemanticJobs } from './semantic-jobs.js';
import { SemanticReindexQueue } from './semantic-reindex-queue.js';
import { SemanticMutationFences } from './semantic-mutation-fences.js';
import { SemanticMutations } from './semantic-mutations.js';
import { projectRemovalNamespace, projectIdFromRemovalNamespace } from './semantic-store-values.js';
export { semanticPurposeForNamespace, PROJECT_REMOVAL_NAMESPACE_PREFIX, projectRemovalNamespace, projectIdFromRemovalNamespace } from './semantic-store-values.js';
import type { SemanticPurpose, SemanticCapability, EmbeddingTarget, RerankerTarget, SemanticProfileRow, SemanticGenerationStatus, SemanticGenerationRow, SemanticNamespaceGenerationRow, SemanticModelStatus, SemanticModelCatalogRow, SemanticItemStatus, SemanticItemRow, SemanticJobKind, SemanticJobStatus, SemanticJobRow, SemanticMutationInput, CapturedSemanticMutationJob, SemanticMutationPassResult, SemanticStatus } from './semantic-store-types.js';
export type { SemanticPurpose, SemanticCapability, SemanticOnnxDtype, EmbeddingTarget, RerankerTarget, SemanticProfileRow, SemanticGenerationStatus, SemanticGenerationRow, SemanticNamespaceGenerationRow, SemanticModelStatus, SemanticModelCatalogRow, SemanticItemStatus, SemanticItemRow, SemanticJobKind, SemanticJobStatus, SemanticJobRow, SemanticMutationInput, CapturedSemanticMutationJob, SemanticMutationPassResult, SemanticStatus } from './semantic-store-types.js';
/** Central control-plane persistence for distributed semantic indexes. */

export class SemanticStore extends SemanticConnection {
  private readonly profiles = new SemanticProfiles(this.db);
  listProfiles = this.profiles.listProfiles.bind(this.profiles);
  getProfile = this.profiles.getProfile.bind(this.profiles);
  upsertProfile = this.profiles.upsertProfile.bind(this.profiles);
  listModels = this.profiles.listModels.bind(this.profiles);
  upsertModel = this.profiles.upsertModel.bind(this.profiles);
  recordModelProbe = this.profiles.recordModelProbe.bind(this.profiles);
  deleteModel = this.profiles.deleteModel.bind(this.profiles);
  private readonly generations = new SemanticGenerations(this.db);
  listGenerations = this.generations.listGenerations.bind(this.generations);
  getGeneration = this.generations.getGeneration.bind(this.generations);
  getActiveGeneration = this.generations.getActiveGeneration.bind(this.generations);
  getWriteGeneration = this.generations.getWriteGeneration.bind(this.generations);
  createGeneration = this.generations.createGeneration.bind(this.generations);
  updateGeneration = this.generations.updateGeneration.bind(this.generations);
  listNamespaceGenerations = this.generations.listNamespaceGenerations.bind(this.generations);
  beginNamespaceGeneration = this.generations.beginNamespaceGeneration.bind(this.generations);
  updateNamespaceProgress = this.generations.updateNamespaceProgress.bind(this.generations);
  clearBuildingGeneration = this.generations.clearBuildingGeneration.bind(this.generations);
  activateNamespaceGeneration = this.generations.activateNamespaceGeneration.bind(this.generations);
  retireUnreferencedGenerations = this.generations.retireUnreferencedGenerations.bind(this.generations);
  listGenerationNamespaces = this.generations.listGenerationNamespaces.bind(this.generations);
  deleteNamespace = this.generations.deleteNamespace.bind(this.generations);
  private readonly items = new SemanticItems(this.db);
  upsertItem = this.items.upsertItem.bind(this.items);
  listItems = this.items.listItems.bind(this.items);
  deleteItemsByVectorIds = this.items.deleteItemsByVectorIds.bind(this.items);
  deleteItemsByItemKeys = this.items.deleteItemsByItemKeys.bind(this.items);
  deleteItemsForNamespaceGeneration = this.items.deleteItemsForNamespaceGeneration.bind(this.items);
  private readonly jobs = new SemanticJobs(this.db);
  createJob = this.jobs.createJob.bind(this.jobs);
  getOrCreateBuildJob = this.jobs.getOrCreateBuildJob.bind(this.jobs);
  hasLiveMutationFence = this.jobs.hasLiveMutationFence.bind(this.jobs);
  getNamespaceBuildRetry = this.jobs.getNamespaceBuildRetry.bind(this.jobs);
  getJob = this.jobs.getJob.bind(this.jobs);
  listJobs = this.jobs.listJobs.bind(this.jobs);
  getJobHighWaterId = this.jobs.getJobHighWaterId.bind(this.jobs);
  currentProjectJob = this.jobs.currentProjectJob.bind(this.jobs);
  listProjectRemovalIds = this.jobs.listProjectRemovalIds.bind(this.jobs);
  hasOpenNamespaceMutationJobs = this.jobs.hasOpenNamespaceMutationJobs.bind(this.jobs);
  requiresExplicitNamespaceReindex = this.jobs.requiresExplicitNamespaceReindex.bind(this.jobs);
  updateJob = this.jobs.updateJob.bind(this.jobs);
  private readonly queue = new SemanticReindexQueue(this.db, this.jobs);
  enqueueReindexJob = this.queue.enqueueReindexJob.bind(this.queue);
  requestProjectRemoval = this.queue.requestProjectRemoval.bind(this.queue);
  hasProjectRemovalRequest = this.queue.hasProjectRemovalRequest.bind(this.queue);
  enqueueNamespaceBackfill = this.queue.enqueueNamespaceBackfill.bind(this.queue);
  recoverExpiredReindexJobs = this.queue.recoverExpiredReindexJobs.bind(this.queue);
  claimNextReindexJob = this.queue.claimNextReindexJob.bind(this.queue);
  renewReindexJobLease = this.queue.renewReindexJobLease.bind(this.queue);
  private readonly fences = new SemanticMutationFences(this.db, this.jobs);
  settleNamespaceMutationFence = this.fences.settleNamespaceMutationFence.bind(this.fences);
  recoverNamespaceMutationFences = this.fences.recoverNamespaceMutationFences.bind(this.fences);
  private readonly mutations = new SemanticMutations(this.db, this.fences, this.jobs, this.generations);
  noteNamespaceMutation = this.mutations.noteNamespaceMutation.bind(this.mutations);
  finishNamespaceMutationPass = this.mutations.finishNamespaceMutationPass.bind(this.mutations);

  getStatus(filter: { purpose?: SemanticPurpose; namespace?: string } = {}): SemanticStatus {
    const namespaces = this.listNamespaceGenerations(filter);
    const resolvedPurpose = filter.purpose ?? namespaces[0]?.purpose;
    let generations = this.listGenerations(resolvedPurpose ? { purpose: resolvedPurpose } : {});
    if (filter.namespace) {
      const ids = new Set(namespaces.flatMap((row) => [row.active_generation_id, row.building_generation_id]));
      generations = generations.filter((generation) => ids.has(generation.id));
    }
    const profiles = resolvedPurpose
      ? [this.getProfile(resolvedPurpose)].filter((p): p is SemanticProfileRow => p !== null)
      : this.listProfiles();
    const jobs: Record<SemanticJobStatus, number> = {
      pending: 0, running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0,
    };
    const jobCounts = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM semantic_jobs
      ${filter.namespace ? 'WHERE namespace = ?' : ''} GROUP BY status
    `).all(...(filter.namespace ? [filter.namespace] : [])) as { status: SemanticJobStatus; count: number }[];
    for (const row of jobCounts) jobs[row.status] = row.count;
    return {
      profiles,
      generations,
      namespaces,
      jobs,
      totals: namespaces.reduce((sum, row) => ({
        expected_items: sum.expected_items + row.expected_items,
        indexed_items: sum.indexed_items + row.indexed_items,
        failed_items: sum.failed_items + row.failed_items,
        delta_items: sum.delta_items + row.delta_items,
      }), { expected_items: 0, indexed_items: 0, failed_items: 0, delta_items: 0 }),
    };
  }
}
