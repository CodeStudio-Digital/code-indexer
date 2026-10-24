import { AppStudioSessionBase } from './app-studio-session-base.js';
import { AppStudioPlans } from './app-studio-plans.js';
import { AppStudioWorkItems } from './app-studio-work-items.js';
import { AppStudioRuns } from './app-studio-runs.js';
import { AppStudioDecisions } from './app-studio-decisions.js';
import { AppStudioDeployments } from './app-studio-deployments.js';

import type { AppStudioWorkItemStatus, AppStudioWorkItemRunStatus, AppStudioSession, CreateAppStudioSessionInput, AppStudioPlanRevision, SaveAppStudioPlanRevisionInput, AppStudioWorkItem, UpsertAppStudioWorkItemInput, AppStudioWorkItemRun, CreateAppStudioWorkItemRunInput, UpdateAppStudioWorkItemRunOptions, AppStudioDecision, AppStudioEvent, AppStudioDeployment, AppStudioStoreHost } from './app-studio-store-types.js';
export type { AppStudioWorkItemStatus, AppStudioWorkItemKind, AppStudioWorkItemRunStatus, AppStudioSession, CreateAppStudioSessionInput, AppStudioPlanRevision, SaveAppStudioPlanRevisionInput, AppStudioWorkItem, UpsertAppStudioWorkItemInput, AppStudioWorkItemRun, CreateAppStudioWorkItemRunInput, UpdateAppStudioWorkItemRunOptions, AppStudioDecision, AppStudioEvent, AppStudioDeployment, AppStudioStoreHost } from './app-studio-store-types.js';
/** App Studio v6 filesystem control-plane store. */

/**
 * No database handle is accepted. Every operational record is an independent
 * atomic JSON entity inside the App Studio global session bundle.
 */
export class AppStudioStore extends AppStudioSessionBase {
  private readonly plans = new AppStudioPlans(this);
  listPlanRevisions = this.plans.listPlanRevisions.bind(this.plans);
  getPlanRevision = this.plans.getPlanRevision.bind(this.plans);
  getLatestPlanRevision = this.plans.getLatestPlanRevision.bind(this.plans);
  getLatestApprovedPlanRevision = this.plans.getLatestApprovedPlanRevision.bind(this.plans);
  savePlanRevision = this.plans.savePlanRevision.bind(this.plans);
  approvePlanRevision = this.plans.approvePlanRevision.bind(this.plans);
  private readonly workItems = new AppStudioWorkItems(this, this.plans);
  listWorkItems = this.workItems.listWorkItems.bind(this.workItems);
  getWorkItem = this.workItems.getWorkItem.bind(this.workItems);
  upsertWorkItems = this.workItems.upsertWorkItems.bind(this.workItems);
  setWorkItemStatus = this.workItems.setWorkItemStatus.bind(this.workItems);
  markWorkItemsStale = this.workItems.markWorkItemsStale.bind(this.workItems);
  refreshReadyWorkItems = this.workItems.refreshReadyWorkItems.bind(this.workItems);
  private readonly runs = new AppStudioRuns(this, this.workItems);
  nextWorkItemRunAttempt = this.runs.nextWorkItemRunAttempt.bind(this.runs);
  createWorkItemRun = this.runs.createWorkItemRun.bind(this.runs);
  getActiveWorkItemRun = this.runs.getActiveWorkItemRun.bind(this.runs);
  listWorkItemRuns = this.runs.listWorkItemRuns.bind(this.runs);
  updateWorkItemRunStatus = this.runs.updateWorkItemRunStatus.bind(this.runs);
  private readonly decisions = new AppStudioDecisions(this);
  listDecisions = this.decisions.listDecisions.bind(this.decisions);
  createDecision = this.decisions.createDecision.bind(this.decisions);
  resolveDecision = this.decisions.resolveDecision.bind(this.decisions);
  private readonly deployments = new AppStudioDeployments(this);
  saveDeployment = this.deployments.saveDeployment.bind(this.deployments);
  getLatestDeployment = this.deployments.getLatestDeployment.bind(this.deployments);
}
