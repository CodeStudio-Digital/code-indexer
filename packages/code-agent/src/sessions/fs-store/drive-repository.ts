import {
  asSessionId,
  type JsonValue,
  type ProjectId,
  type SessionId,
} from '@mcp/session-storage';
import { projectConversation } from './conversation-codec.js';
import {
  FsSessionEntityFiles,
  type FsEntityEnvelope,
} from './entity-files.js';
import { FsGoalRepository } from './goal-repository.js';
import { FsPlanningRepository } from './planning-repository.js';
import { FsSessionDirectory } from './session-directory.js';
import { FsTaskRepository } from './task-repository.js';
import type {
  FsDriveAggregate,
  FsDriveInjectionPayload,
  FsInvestigationRow,
  FsRecordInvestigationInput,
  FsRememberInput,
  FsSessionMemoryRow,
  FsSessionStateData,
  TasksState,
} from './operational-types.js';
import type { FsToolCallRecord } from './types.js';

interface MemoryData {
  kind: string;
  title: string;
  body: string;
  pinned: boolean;
}
interface InvestigationData {
  project_id: ProjectId | null;
  topic: string;
  summary: string;
  body: string;
  source_label: string | null;
  agent_type: string | null;
  tokens: number;
}
const READ_TOOLS = new Set([
  'read_file',
  'get_file_skeleton',
  'view_image',
]);
const WRITE_TOOLS = new Set([
  'create_file',
  'edit_file',
  'multi_edit',
  'write_file',
  'apply_patch',
]);
function memoryRow(
  sessionId: SessionId,
  item: FsEntityEnvelope<JsonValue>,
): FsSessionMemoryRow {
  const data = item.data as unknown as MemoryData;
  return {
    id: item.id,
    seq: item.seq,
    revision: item.revision,
    session_id: sessionId,
    kind: data.kind,
    title: data.title,
    body: data.body,
    pinned: data.pinned,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}
function investigationRow(
  sessionId: SessionId,
  item: FsEntityEnvelope<JsonValue>,
): FsInvestigationRow {
  const data = item.data as unknown as InvestigationData;
  return {
    id: item.id,
    seq: item.seq,
    project_id: data.project_id,
    session_id: sessionId,
    topic: data.topic,
    summary: data.summary,
    body: data.body,
    source_label: data.source_label,
    agent_type: data.agent_type,
    tokens: data.tokens,
    created_at: item.created_at,
  };
}
function pathsFromArgs(call: FsToolCallRecord): string[] {
  const args = call.args as Record<string, unknown>;
  const direct = args.path ?? args.file_path;
  if (typeof direct === 'string' && direct) return [direct];
  const raw =
    typeof args._raw === 'string'
      ? args._raw
      : typeof args.input === 'string'
        ? args.input
        : '';
  return raw
    ? [...raw.matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/gm)].map(
        (match) => match[1].trim(),
      )
    : [];
}
function commandFromArgs(call: FsToolCallRecord): string {
  const args = call.args as Record<string, unknown>;
  const command = args.command ?? args.cmd ?? args.script;
  return typeof command === 'string' ? command.trim() : '';
}
function todosFromTasks(
  state: TasksState | null,
): Array<{ status: string; label: string }> {
  if (!state || (state.gate ?? 'approve') !== 'track') return [];
  return state.tasks
    .filter((task) => typeof task.content === 'string')
    .map((task) => ({
      status: task.status,
      label: task.content!,
    }));
}
export class FsDriveRepository {
  constructor(
    private readonly directory: FsSessionDirectory,
    private readonly entities: FsSessionEntityFiles,
    private readonly planning: FsPlanningRepository,
    private readonly tasks: FsTaskRepository,
    private readonly goals: FsGoalRepository,
  ) {}
  async remember(
    sessionId: SessionId | string,
    input: FsRememberInput,
  ): Promise<FsSessionMemoryRow> {
    const records = await this.entities.list<JsonValue>(
      sessionId,
      'memory',
      'memory',
    );
    const existing = records.find(
      (item) =>
        (item.data as unknown as MemoryData).title === input.title,
    );
    const data: MemoryData = {
      kind: input.kind?.trim() || 'fact',
      title: input.title,
      body: input.body,
      pinned: input.pinned === true,
    };
    const operationKey = {
      action: 'remember',
      title: input.title,
      body: input.body,
      kind: data.kind,
      pinned: data.pinned,
    };
    const written = existing
      ? await this.entities.update<MemoryData>(
          sessionId,
          'memory',
          existing.id,
          () => data,
          {
            operation_id: input.operation_id,
            operation_key: operationKey,
          },
        )
      : await this.entities.create(sessionId, 'memory', {
          kind: 'memory',
          data,
          operation_id: input.operation_id,
          operation_key: operationKey,
        });
    return memoryRow(asSessionId(String(sessionId)), written!);
  }
  async listMemory(
    sessionId: SessionId | string,
    options: { kind?: string } = {},
  ): Promise<FsSessionMemoryRow[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'memory',
      'memory',
    ))
      .map((item) => memoryRow(asSessionId(String(sessionId)), item))
      .filter((item) => !options.kind || item.kind === options.kind)
      .sort(
        (left, right) =>
          Number(right.pinned) - Number(left.pinned) ||
          Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
          right.seq - left.seq,
      );
  }
  async setMemoryPinned(
    sessionId: SessionId | string,
    memoryId: string,
    pinned: boolean,
  ): Promise<boolean> {
    return (
      (await this.entities.update<MemoryData>(
        sessionId,
        'memory',
        memoryId,
        (current) => ({ ...current, pinned }),
      )) != null
    );
  }
  async deleteMemory(
    sessionId: SessionId | string,
    memoryId: string,
  ): Promise<boolean> {
    return (
      (await this.entities.update(
        sessionId,
        'memory',
        memoryId,
        (data) => data,
        { delete: true },
      )) != null
    );
  }
  async copyMemory(
    fromSessionId: SessionId | string,
    toSessionId: SessionId | string,
  ): Promise<number> {
    const memories = await this.listMemory(fromSessionId);
    for (const memory of memories) {
      await this.remember(toSessionId, {
        title: memory.title,
        body: memory.body,
        kind: memory.kind,
        pinned: memory.pinned,
        operation_id: `memory-copy:${fromSessionId}:${memory.id}`,
      });
    }
    return memories.length;
  }
  async memoryForInjection(
    sessionId: SessionId | string,
    limit = 3,
  ): Promise<FsSessionMemoryRow[]> {
    return (await this.listMemory(sessionId)).slice(
      0,
      Math.max(0, limit),
    );
  }
  async memoryForState(
    sessionId: SessionId | string,
    options: { limit: number; autoLimit: number },
  ): Promise<FsSessionMemoryRow[]> {
    const output: FsSessionMemoryRow[] = [];
    let automatic = 0;
    for (const memory of await this.listMemory(sessionId)) {
      if (output.length >= options.limit) break;
      if (memory.kind.startsWith('auto:')) {
        if (automatic >= options.autoLimit) continue;
        automatic += 1;
      }
      output.push(memory);
    }
    return output;
  }
  async recordInvestigation(
    input: FsRecordInvestigationInput,
  ): Promise<FsInvestigationRow> {
    const projectId = await this.projectIdForSession(input.session_id);
    const created = await this.entities.create(
      input.session_id,
      'memory',
      {
        kind: 'investigation',
        data: {
          project_id: projectId,
          topic: input.topic,
          summary: input.summary,
          body: input.body ?? '',
          source_label: input.source_label ?? null,
          agent_type: input.agent_type ?? null,
          tokens: input.tokens ?? 0,
        } satisfies InvestigationData,
        operation_id: input.operation_id,
      },
    );
    return investigationRow(input.session_id, created);
  }
  async listInvestigations(
    sessionId: SessionId | string,
    limit = 50,
  ): Promise<FsInvestigationRow[]> {
    return (await this.entities.list<JsonValue>(
      sessionId,
      'memory',
      'investigation',
    ))
      .map((item) => investigationRow(asSessionId(String(sessionId)), item))
      .sort((left, right) => right.seq - left.seq)
      .slice(0, Math.max(0, limit));
  }
  async projectIdForSession(
    sessionId: SessionId | string,
  ): Promise<ProjectId | null> {
    return (await this.directory.requireEntry(sessionId)).session
      .owner_project_id;
  }
  async listInvestigationsForProject(
    projectId: ProjectId,
  ): Promise<FsInvestigationRow[]> {
    await this.directory.ensureCatalog();
    const entries = this.directory.catalog.list().filter(
      (entry) =>
        entry.session.kind === 'coder' &&
        (entry.session.owner_project_id === projectId ||
          entry.session.linked_projects.some(
            (project) => project.project_id === projectId,
          )),
    );
    const rows = await Promise.all(
      entries.map((entry) =>
        this.listInvestigations(entry.session.id, Number.MAX_SAFE_INTEGER),
      ),
    );
    return rows
      .flat()
      .filter((row) => row.project_id === projectId)
      .sort(
        (left, right) =>
          Date.parse(left.created_at) - Date.parse(right.created_at),
      );
  }
  async recallInvestigations(
    sessionId: SessionId | string,
    query: string,
    limit = 8,
  ): Promise<FsInvestigationRow[]> {
    const projectId = await this.projectIdForSession(sessionId);
    const rows =
      projectId == null
        ? await this.listInvestigations(
            sessionId,
            Number.MAX_SAFE_INTEGER,
          )
        : await this.listInvestigationsForProject(projectId);
    const needle = query.trim().toLocaleLowerCase();
    return rows
      .filter(
        (row) =>
          !needle ||
          row.topic.toLocaleLowerCase().includes(needle) ||
          row.summary.toLocaleLowerCase().includes(needle),
      )
      .sort(
        (left, right) =>
          Date.parse(right.created_at) - Date.parse(left.created_at),
      )
      .slice(0, Math.max(0, limit));
  }
  async recallInvestigationsByIds(
    sessionId: SessionId | string,
    ids: readonly string[],
    limit = 8,
  ): Promise<FsInvestigationRow[]> {
    const rows = await this.recallInvestigations(
      sessionId,
      '',
      Number.MAX_SAFE_INTEGER,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    return [...new Set(ids)]
      .flatMap((id) => byId.get(id) ?? [])
      .slice(0, Math.max(0, limit));
  }
  private async toolCalls(
    sessionId: SessionId | string,
  ): Promise<FsToolCallRecord[]> {
    const entry = await this.directory.requireEntry(sessionId);
    return projectConversation(
      this.directory.repository.readConversationSync(entry.location),
    ).toolCalls;
  }
  async getFileMap(
    sessionId: SessionId | string,
  ): Promise<{ read: string[]; changed: string[] }> {
    const read = new Set<string>();
    const changed = new Set<string>();
    for (const call of (await this.toolCalls(sessionId)).reverse()) {
      const target = WRITE_TOOLS.has(call.tool_name)
        ? changed
        : READ_TOOLS.has(call.tool_name)
          ? read
          : null;
      if (!target) continue;
      for (const path of pathsFromArgs(call)) target.add(path);
    }
    for (const path of changed) read.delete(path);
    return {
      read: [...read].slice(0, 200),
      changed: [...changed].slice(0, 200),
    };
  }
  async getCommandTrail(
    sessionId: SessionId | string,
    limit = 40,
  ): Promise<Array<{ command: string; isError: boolean }>> {
    return (await this.toolCalls(sessionId))
      .filter(
        (call) =>
          call.tool_name === 'run_command' ||
          call.tool_name === 'exec_command',
      )
      .slice(-Math.max(0, limit))
      .map((call) => ({
        command: commandFromArgs(call),
        isError: call.is_error,
      }))
      .filter((item) => item.command.length > 0);
  }

  async didRunSucceed(sessionId: SessionId | string): Promise<boolean> {
    const commands = await this.getCommandTrail(
      sessionId,
      Number.MAX_SAFE_INTEGER,
    );
    return commands.length > 0 && !commands.at(-1)!.isError;
  }

  async getDriveAggregate(
    sessionId: SessionId | string,
  ): Promise<FsDriveAggregate> {
    const [memory, investigations, fileMap, plans, tasks] =
      await Promise.all([
        this.listMemory(sessionId),
        this.listInvestigations(sessionId),
        this.getFileMap(sessionId),
        this.planning.listPlans(sessionId),
        this.tasks.getState(sessionId),
      ]);
    return { memory, investigations, fileMap, plans, tasks };
  }

  async getDriveInjectionPayload(
    sessionId: SessionId | string,
  ): Promise<FsDriveInjectionPayload> {
    const [plans, memories, investigations] = await Promise.all([
      this.planning.listPlans(sessionId),
      this.memoryForInjection(sessionId, 3),
      this.recallInvestigations(
        sessionId,
        '',
        Number.MAX_SAFE_INTEGER,
      ),
    ]);
    return {
      activePlan: plans[0]
        ? { text: plans[0].plan_text, status: plans[0].status }
        : null,
      sessionMemory: memories.map((memory) => ({
        id: memory.id,
        title: memory.title,
        body: memory.body,
      })),
      investigationCount: investigations.length,
    };
  }

  async getSessionStateData(
    sessionId: SessionId | string,
  ): Promise<FsSessionStateData> {
    const [goal, plans, tasks, notes, fileMap, investigations] =
      await Promise.all([
        this.goals.get(sessionId),
        this.planning.listPlans(sessionId),
        this.tasks.getState(sessionId),
        this.memoryForState(sessionId, { limit: 6, autoLimit: 2 }),
        this.getFileMap(sessionId),
        this.recallInvestigations(
          sessionId,
          '',
          Number.MAX_SAFE_INTEGER,
        ),
      ]);
    return {
      goal: goal ? { text: goal.text, status: goal.status } : null,
      activePlan: plans[0]
        ? { text: plans[0].plan_text, status: plans[0].status }
        : null,
      todos: todosFromTasks(tasks),
      notes: notes.map((note) => ({
        id: note.id,
        title: note.title,
        body: note.body,
        kind: note.kind,
        pinned: note.pinned,
      })),
      filesChanged: fileMap.changed,
      investigationCount: investigations.length,
    };
  }
}
