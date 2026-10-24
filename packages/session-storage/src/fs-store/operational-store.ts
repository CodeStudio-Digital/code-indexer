import type {
  JsonValue,
  ProjectId,
  SessionId,
} from '@mcp/session-storage';
import { FsAdvancedStateRepository } from './advanced-state-repository.js';
import { FsDriveRepository } from './drive-repository.js';
import { FsSessionEntityFiles } from './entity-files.js';
import { FsFilesystemRootRepository } from './filesystem-root-repository.js';
import { FsGoalRepository } from './goal-repository.js';
import { FsPlanningRepository } from './planning-repository.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsSessionGroupRepository } from './session-group-repository.js';
import { FsTaskRepository } from './task-repository.js';
import { FsTaskRunRepository } from './task-run-repository.js';
import { FsToolStateRepository } from './tool-state-repository.js';
import {
  installSecondaryOperationalApi,
  type FsSecondaryOperationalApi,
} from './operational-secondary-api.js';
import type {
  CoderExecutionMode,
  CoderPlanStatus,
  FsRecordInvestigationInput,
  FsRecordPlanInput,
  FsRecordSessionInput,
  FsRememberInput,
  FsToolOutputCapLevel,
  FsUpsertGoalInput,
  FsSessionGoal,
} from './operational-types.js';

export class FsOperationalSessionStore {
  readonly advanced: FsAdvancedStateRepository;
  readonly goals: FsGoalRepository;
  readonly planning: FsPlanningRepository;
  readonly tasks: FsTaskRepository;
  readonly taskRuns: FsTaskRunRepository;
  readonly drive: FsDriveRepository;
  readonly tools: FsToolStateRepository;
  readonly groups: FsSessionGroupRepository;
  readonly filesystemRoots: FsFilesystemRootRepository;

  constructor(directory: FsSessionDirectory) {
    const entities = new FsSessionEntityFiles(directory);
    this.advanced = new FsAdvancedStateRepository(directory, entities);
    this.goals = new FsGoalRepository(directory);
    this.planning = new FsPlanningRepository(entities);
    this.tasks = new FsTaskRepository(entities);
    this.taskRuns = new FsTaskRunRepository(directory, entities);
    this.drive = new FsDriveRepository(
      directory,
      entities,
      this.planning,
      this.tasks,
      this.goals,
    );
    this.tools = new FsToolStateRepository(directory, entities);
    this.groups = new FsSessionGroupRepository(directory);
    this.filesystemRoots = new FsFilesystemRootRepository(entities);
    installSecondaryOperationalApi(this, this);
  }

  getRuntimeSessionState = thisCall(
    (self, id: SessionId | string) => self.advanced.get(id),
    this,
  );
  setSessionTemperature = thisCall(
    (self, id: SessionId | string, value: number | null) =>
      self.advanced.setTemperature(id, value),
    this,
  );
  setSessionReasoningEffort = thisCall(
    (self, id: SessionId | string, value: string | null) =>
      self.advanced.setReasoningEffort(id, value),
    this,
  );
  setSessionExecutionMode = thisCall(
    (self, id: SessionId | string, value: CoderExecutionMode) =>
      self.advanced.setExecutionMode(id, value),
    this,
  );
  setSessionThinkingEnabled = thisCall(
    (self, id: SessionId | string, value: boolean) =>
      self.advanced.setThinkingEnabled(id, value),
    this,
  );
  setSessionBlockCodeComments = thisCall(
    (self, id: SessionId | string, value: boolean) =>
      self.advanced.setBlockCodeComments(id, value),
    this,
  );
  setSessionRunLimits = thisCall(
    (
      self,
      id: SessionId | string,
      maxTurns: number | null,
      maxAutoContinues: number,
    ) => self.advanced.setRunLimits(id, maxTurns, maxAutoContinues),
    this,
  );
  setSessionPlanDepth = thisCall(
    (self, id: SessionId | string, value: string | null) =>
      self.advanced.setPlanDepth(id, value),
    this,
  );
  setSessionResponseLanguage = thisCall(
    (self, id: SessionId | string, value: string | null) =>
      self.advanced.setResponseLanguage(id, value),
    this,
  );
  setSessionOutputStyle = thisCall(
    (self, id: SessionId | string, value: string | null) =>
      self.advanced.setOutputStyle(id, value),
    this,
  );
  setSessionPreflightSeed = thisCall(
    (self, id: SessionId | string, value: string | null) =>
      self.advanced.setPreflightSeed(id, value),
    this,
  );
  setSessionUnrestrictedToolOutput = thisCall(
    (self, id: SessionId | string, value: boolean | null) =>
      self.advanced.setUnrestrictedToolOutput(id, value),
    this,
  );
  setSessionToolOutputCapLevel = thisCall(
    (self, id: SessionId | string, value: FsToolOutputCapLevel | null) =>
      self.advanced.setToolOutputCapLevel(id, value),
    this,
  );
  setLastResponseState = thisCall(
    (
      self,
      id: SessionId | string,
      responseId: string | null,
      count: number | null,
    ) => self.advanced.setLastResponseState(id, responseId, count),
    this,
  );
  getSessionFallback = thisCall(
    (self, id: SessionId | string) => self.advanced.getFallback(id),
    this,
  );
  setSessionFallback = thisCall(
    (
      self,
      id: SessionId | string,
      provider: string | null,
      model: string | null,
    ) => self.advanced.setFallback(id, provider, model),
    this,
  );
  setSessionWorktree = thisCall(
    (self, id: SessionId | string, path: string | null) =>
      self.advanced.setWorktree(id, path),
    this,
  );
  setSessionBaseCommit = thisCall(
    (self, id: SessionId | string, sha: string | null) =>
      self.advanced.setBaseCommit(id, sha),
    this,
  );
  markSessionReviewedNow = thisCall(
    (self, id: SessionId | string) => self.advanced.markReviewedNow(id),
    this,
  );
  setMemoryDistilledBoundary = thisCall(
    (self, id: SessionId | string, seq: number) =>
      self.advanced.setMemoryBoundary(id, seq),
    this,
  );
  getMemoryDistilledBoundary = thisCall(
    (self, id: SessionId | string) => self.advanced.getMemoryBoundary(id),
    this,
  );
  bumpMemoryDistillAttempts = thisCall(
    (self, id: SessionId | string) => self.advanced.bumpMemoryAttempts(id),
    this,
  );
  resetMemoryDistillAttempts = thisCall(
    (self, id: SessionId | string) => self.advanced.resetMemoryAttempts(id),
    this,
  );
  getOrCreateCloudCodeSessionId = thisCall(
    (self, id: SessionId | string) =>
      self.advanced.getOrCreateCloudSessionId(id),
    this,
  );
  stageManualAgentTransition = thisCall(
    (self, id: SessionId | string, agent: string | null) =>
      self.advanced.stageAgentTransition(id, agent),
    this,
  );
  consumePendingAgentTransition = thisCall(
    (self, id: SessionId | string) =>
      self.advanced.consumeAgentTransition(id),
    this,
  );
  getPendingAgentTransition = thisCall(
    (self, id: SessionId | string) =>
      self.advanced
        .get(id)
        .then((state) => state.pending_agent_transition),
    this,
  );
  setSessionToolPermissionMode = thisCall(
    (
      self,
      id: SessionId | string,
      mode: 'ask' | 'auto' | 'unrestricted' | null,
    ) => self.advanced.setToolPermissionMode(id, mode),
    this,
  );
  addToolPermissionGrant = thisCall(
    (self, id: SessionId | string, toolName: string) =>
      self.advanced.addToolPermissionGrant(id, toolName),
    this,
  );
  setSessionToolProfile = thisCall(
    (
      self,
      id: SessionId | string,
      profile: 'bootstrap' | 'navigate' | 'full',
    ) => self.advanced.setToolProfile(id, profile),
    this,
  );
  mergeSessionToolsetState = thisCall(
    (
      self,
      id: SessionId | string,
      patch: {
        addExtraTiers?: readonly string[];
        addPins?: readonly string[];
        pins?: readonly string[];
        visibleCap?: number | null;
      },
    ) => self.advanced.mergeToolsetState(id, patch),
    this,
  );
  getSessionConfigLock = thisCall(
    (self, id: SessionId | string) => self.advanced.getConfigLock(id),
    this,
  );
  setSessionConfigLock = thisCall(
    (
      self,
      id: SessionId | string,
      lock: Readonly<Record<string, JsonValue>> | null,
    ) => self.advanced.setConfigLock(id, lock),
    this,
  );
  getConfigLock = this.getSessionConfigLock;
  setConfigLock = this.setSessionConfigLock;

  getSessionGoal = thisCall(
    (self, id: SessionId | string) => self.goals.get(id),
    this,
  );
  upsertSessionGoal = thisCall(
    (self, id: SessionId | string, input: FsUpsertGoalInput) =>
      self.goals.upsert(id, input),
    this,
  );
  clearSessionGoal = thisCall(
    (
      self,
      id: SessionId | string,
      options?: { expected_revision?: number; operation_id?: string },
    ) => self.goals.clear(id, options),
    this,
  );

  recordPlan = thisCall(
    (self, input: FsRecordPlanInput) => self.planning.recordPlan(input),
    this,
  );
  resolvePlan = thisCall(
    (
      self,
      id: SessionId | string,
      toolUseId: string,
      status: CoderPlanStatus,
      feedback?: string,
      operationId?: string,
    ) =>
      self.planning.resolvePlan(
        id,
        toolUseId,
        status,
        feedback,
        operationId,
      ),
    this,
  );
  resolveLatestPendingPlan = thisCall(
    (
      self,
      id: SessionId | string,
      status: CoderPlanStatus,
      feedback?: string,
      operationId?: string,
    ) =>
      self.planning.resolveLatestPendingPlan(
        id,
        status,
        feedback,
        operationId,
      ),
    this,
  );
  listPlans = thisCall(
    (self, id: SessionId | string) => self.planning.listPlans(id),
    this,
  );
  getLatestPlan = thisCall(
    (self, id: SessionId | string, signal?: AbortSignal) => self.planning.latestPlan(id, signal), this,
  );
  getPlan = thisCall(
    (self, id: SessionId | string, planId: string) =>
      self.planning.getPlan(id, planId),
    this,
  );
  clearPlansFrom = thisCall(
    (self, id: SessionId | string, seq: number) =>
      self.planning.clearPlansFrom(id, seq),
    this,
  );
  recordSessionInput = thisCall(
    (self, input: FsRecordSessionInput) =>
      self.planning.recordInput(input),
    this,
  );
  listSessionInputs = thisCall(
    (self, id: SessionId | string) => self.planning.listInputs(id),
    this,
  );

  rememberMemory = thisCall(
    (self, id: SessionId | string, input: FsRememberInput, beforePublish?: () => void) =>
      self.drive.remember(id, input, beforePublish),
    this,
  );
  listSessionMemory = thisCall(
    (self, id: SessionId | string, options?: { kind?: string; limit?: number; offset?: number; signal?: AbortSignal }) =>
      self.drive.listMemory(id, options),
    this,
  );
  listSessionStateNotes = thisCall(
    (self, id: SessionId | string) => self.drive.memoryForState(id, { limit: 6, autoLimit: 2 }), this,
  );
  setSessionMemoryPinned = thisCall(
    (self, id: SessionId | string, memoryId: string, pinned: boolean) =>
      self.drive.setMemoryPinned(id, memoryId, pinned),
    this,
  );
  deleteSessionMemory = thisCall(
    (self, id: SessionId | string, memoryId: string) =>
      self.drive.deleteMemory(id, memoryId),
    this,
  );
  copySessionMemory = thisCall(
    (
      self,
      fromId: SessionId | string,
      toId: SessionId | string,
    ) => self.drive.copyMemory(fromId, toId),
    this,
  );
  recordInvestigation = thisCall(
    (self, input: FsRecordInvestigationInput) =>
      self.drive.recordInvestigation(input),
    this,
  );
  recallInvestigations = thisCall(
    (self, id: SessionId | string, query: string, limit?: number, signal?: AbortSignal) =>
      self.drive.recallInvestigations(id, query, limit, signal),
    this,
  );
  recallInvestigationsByIds = thisCall(
    (
      self,
      id: SessionId | string,
      ids: readonly string[],
      limit?: number,
      signal?: AbortSignal,
    ) => self.drive.recallInvestigationsByIds(id, ids, limit, signal),
    this,
  );
  listInvestigations = thisCall(
    (self, id: SessionId | string, limit?: number) =>
      self.drive.listInvestigations(id, limit),
    this,
  );
  listInvestigationsForSemanticIndex = thisCall(
    (self, projectId: ProjectId) =>
      self.drive.listInvestigationsForProject(projectId),
    this,
  );
  investigationProjectId = thisCall(
    (self, id: SessionId | string) =>
      self.drive.projectIdForSession(id),
    this,
  );
  getDriveAggregate = thisCall(
    (self, id: SessionId | string) => self.drive.getDriveAggregate(id),
    this,
  );
  getSessionFileMap = thisCall(
    (self, id: SessionId | string) => self.drive.getFileMap(id),
    this,
  );
  getDriveInjectionPayload = thisCall(
    (self, id: SessionId | string) =>
      self.drive.getDriveInjectionPayload(id),
    this,
  );
  getSessionStateData = thisCall(
    (self, id: SessionId | string) => self.drive.getSessionStateData(id),
    this,
  );
  getCommandTrail = thisCall(
    (self, id: SessionId | string, limit?: number) =>
      self.drive.getCommandTrail(id, limit),
    this,
  );
  didRunSucceed = thisCall(
    (self, id: SessionId | string) => self.drive.didRunSucceed(id),
    this,
  );

}

export interface FsOperationalSessionStore extends FsSecondaryOperationalApi {}

function thisCall<
  Self,
  Args extends readonly unknown[],
  Result,
>(
  call: (self: Self, ...args: Args) => Result,
  self: Self,
): (...args: Args) => Result {
  return (...args) => call(self, ...args);
}

export type FsOperationalSessionApi = Pick<
  FsOperationalSessionStore,
  Exclude<
    keyof FsOperationalSessionStore,
    | 'advanced'
    | 'goals'
    | 'planning'
    | 'tasks'
    | 'taskRuns'
    | 'drive'
    | 'tools'
    | 'groups'
    | 'filesystemRoots'
  >
>;

export { installOperationalSessionApi } from './operational-api-install.js';
