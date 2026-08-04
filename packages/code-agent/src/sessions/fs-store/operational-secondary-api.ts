import type {
  ProjectId,
  SessionId,
} from '@mcp/session-storage';
import type { FsFilesystemRootRepository } from './filesystem-root-repository.js';
import type { FsSessionGroupRepository } from './session-group-repository.js';
import type { FsTaskRepository } from './task-repository.js';
import type { FsTaskRunRepository } from './task-run-repository.js';
import type { FsToolStateRepository } from './tool-state-repository.js';
import type {
  CoderTask,
  FsCreateTaskRunInput,
  FsRecordTasksInput,
  FsSessionEvent,
  FsTaskRunPage,
  FsUpdateTaskRunPatch,
  FsUpsertTaskRunItemInput,
  TaskExecutionMode,
} from './operational-types.js';
import type { FsToolCallRecord } from './types.js';

export interface FsSecondaryOperationalServices {
  readonly tasks: FsTaskRepository;
  readonly taskRuns: FsTaskRunRepository;
  readonly tools: FsToolStateRepository;
  readonly groups: FsSessionGroupRepository;
  readonly filesystemRoots: FsFilesystemRootRepository;
}

class FsSecondaryOperationalStore {
  constructor(private readonly services: FsSecondaryOperationalServices) {}

  recordTasks = thisCall(
    (self, input: FsRecordTasksInput) => self.services.tasks.record(input),
    this,
  );
  resolveTasks = thisCall(
    (
      self,
      id: SessionId | string,
      verdict: {
        approved: boolean;
        tasks?: CoderTask[];
        execution_mode?: TaskExecutionMode | null;
      },
      operationId?: string,
    ) => self.services.tasks.resolve(id, verdict, operationId),
    this,
  );
  updateTaskStatus = thisCall(
    (
      self,
      id: SessionId | string,
      taskId: string,
      patch: Partial<CoderTask>,
      operationId?: string,
    ) => self.services.tasks.updateStatus(id, taskId, patch, operationId),
    this,
  );
  getTasksState = thisCall(
    (self, id: SessionId | string) => self.services.tasks.getState(id),
    this,
  );
  clearTasksState = thisCall(
    (self, id: SessionId | string, operationId?: string) =>
      self.services.tasks.clear(id, operationId),
    this,
  );
  recoverStaleTasks = thisCall(
    (self, id: SessionId | string) => self.services.tasks.recoverStale(id),
    this,
  );
  getTasksRow = thisCall(
    (self, id: SessionId | string) => self.services.tasks.getRow(id),
    this,
  );
  createTaskRun = thisCall(
    (self, input: FsCreateTaskRunInput) => self.services.taskRuns.create(input),
    this,
  );
  updateTaskRun = thisCall(
    (
      self,
      id: SessionId | string,
      runId: string,
      patch: FsUpdateTaskRunPatch,
    ) => self.services.taskRuns.update(id, runId, patch),
    this,
  );
  upsertTaskRunItem = thisCall(
    (self, input: FsUpsertTaskRunItemInput) =>
      self.services.taskRuns.upsertItem(input),
    this,
  );
  getTaskRun = thisCall(
    (self, id: SessionId | string, runId: string) =>
      self.services.taskRuns.get(id, runId),
    this,
  );
  listTaskRunsBySession = thisCall(
    (self, id: SessionId | string, limit?: number) =>
      self.services.taskRuns.list(id, limit),
    this,
  );
  listTaskRunsPage = thisCall(
    (self, id: SessionId | string, offset: number, limit: number) =>
      self.services.taskRuns.listPage(id, offset, limit),
    this,
  ) as (
    id: SessionId | string,
    offset: number,
    limit: number,
  ) => Promise<FsTaskRunPage>;
  listTaskRunItems = thisCall(
    (self, id: SessionId | string, runId: string) =>
      self.services.taskRuns.listItems(id, runId),
    this,
  );
  getTaskRunWithItems = thisCall(
    (self, id: SessionId | string, runId: string) =>
      self.services.taskRuns.getWithItems(id, runId),
    this,
  );
  findLastCompletedTaskItem = thisCall(
    (self, id: SessionId | string, taskId: string) =>
      self.services.taskRuns.findLastCompletedItem(id, taskId),
    this,
  );
  recoverRunningTaskRuns = thisCall(
    (self, id?: SessionId | string) =>
      self.services.taskRuns.recoverRunning(id),
    this,
  );

  getSessionDisabledTools = thisCall(
    (self, id: SessionId | string) => self.services.tools.getDisabled(id),
    this,
  );
  setSessionToolDisabled = thisCall(
    (
      self,
      id: SessionId | string,
      toolName: string,
      disabled: boolean,
    ) => self.services.tools.setDisabled(id, toolName, disabled),
    this,
  );
  bulkSetSessionToolsDisabled = thisCall(
    (
      self,
      id: SessionId | string,
      toolNames: readonly string[],
      disabled: boolean,
    ) => self.services.tools.bulkSetDisabled(id, toolNames, disabled),
    this,
  );
  copyToolConfig = thisCall(
    (
      self,
      fromId: SessionId | string,
      toId: SessionId | string,
    ) => self.services.tools.copyDisabled(fromId, toId),
    this,
  );
  setSessionActiveSkills = thisCall(
    (self, id: SessionId | string, skillIds: readonly string[]) =>
      self.services.tools.setActiveSkills(id, skillIds),
    this,
  );
  getToolCallStats = thisCall(
    (self, id: SessionId | string, recentLimit?: number) =>
      self.services.tools.stats(id, recentLimit),
    this,
  );
  listToolCallSummaries = thisCall(
    (self, id: SessionId | string, offset: number, limit: number) =>
      self.services.tools.listSummaryPage(id, offset, limit),
    this,
  );
  appendSessionEvent = thisCall(
    (
      self,
      id: SessionId | string,
      type: string,
      payload: unknown,
      operationId?: string,
    ) => self.services.tools.appendEvent(id, type, payload, operationId),
    this,
  );
  listSessionEvents = thisCall(
    (self, id: SessionId | string, type?: string) =>
      self.services.tools.listEvents(id, type),
    this,
  ) as (
    id: SessionId | string,
    type?: string,
  ) => Promise<FsSessionEvent[]>;
  getSessionEventByOperationId = thisCall(
    (
      self,
      id: SessionId | string,
      operationId: string,
      type?: string,
    ) => self.services.tools.getEventByOperationId(id, operationId, type),
    this,
  ) as (
    id: SessionId | string,
    operationId: string,
    type?: string,
  ) => Promise<FsSessionEvent | null>;
  listSessionToolCalls = thisCall(
    (self, id: SessionId | string) =>
      self.services.tools.listCalls(id),
    this,
  ) as (
    id: SessionId | string,
  ) => Promise<FsToolCallRecord[]>;

  listGroups = thisCall(
    (self, projectId: ProjectId | null) =>
      self.services.groups.list(projectId),
    this,
  );
  createGroup = thisCall(
    (
      self,
      projectId: ProjectId | null,
      input: {
        name: string;
        color?: string | null;
        sort_order?: number;
      },
    ) => self.services.groups.create(projectId, input),
    this,
  );
  updateGroup = thisCall(
    (
      self,
      projectId: ProjectId | null,
      groupId: string,
      patch: {
        name?: string;
        color?: string | null;
        sort_order?: number;
      },
    ) => self.services.groups.update(projectId, groupId, patch),
    this,
  );
  deleteGroup = thisCall(
    (self, projectId: ProjectId | null, groupId: string) =>
      self.services.groups.delete(projectId, groupId),
    this,
  );
  setSessionGroup = thisCall(
    (self, id: SessionId | string, groupId: string | null) =>
      self.services.groups.setSessionGroup(id, groupId),
    this,
  );

  listSessionFilesystemRoots = thisCall(
    (self, id: SessionId | string) =>
      self.services.filesystemRoots.list(id),
    this,
  );
  upsertSessionFilesystemRoot = thisCall(
    (
      self,
      id: SessionId | string,
      path: string,
      access: 'read' | 'write',
      operationId?: string,
    ) => self.services.filesystemRoots.upsert(id, path, access, operationId),
    this,
  );
  removeSessionFilesystemRoot = thisCall(
    (
      self,
      id: SessionId | string,
      rootId: string,
      operationId?: string,
    ) => self.services.filesystemRoots.remove(id, rootId, operationId),
    this,
  );
}

function thisCall<Self, Args extends readonly unknown[], Result>(
  call: (self: Self, ...args: Args) => Result,
  self: Self,
): (...args: Args) => Result {
  return (...args) => call(self, ...args);
}

export type FsSecondaryOperationalApi = Pick<
  FsSecondaryOperationalStore,
  Exclude<keyof FsSecondaryOperationalStore, 'services'>
>;

export function installSecondaryOperationalApi(
  target: object,
  services: FsSecondaryOperationalServices,
): void {
  const operations = new FsSecondaryOperationalStore(services);
  for (const name of Object.keys(operations)) {
    if (name === 'services') continue;
    Object.defineProperty(target, name, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: operations[name as keyof FsSecondaryOperationalStore],
    });
  }
}
