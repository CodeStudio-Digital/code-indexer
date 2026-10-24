import type { SessionId } from '@mcp/session-storage';
import type { TasksState } from '../session-state-types.js';
import type {
  FsSessionGoal,
  FsTasksRow,
} from './operational-types.js';
import type { FsCoderSession } from './types.js';

export interface FsSessionWorkbenchBootstrapSource {
  getSession(id: SessionId | string): Promise<FsCoderSession | null>;
  getSessionGoal(id: SessionId | string): Promise<FsSessionGoal | null>;
  getTasksRow(id: SessionId | string): Promise<FsTasksRow | null>;
  countConversationChapters(id: SessionId | string): Promise<number>;
}

export interface FsSessionWorkbenchBootstrapProjection {
  session: FsCoderSession;
  goal: FsSessionGoal | null;
  tasks: TasksState | null;
  tasksRevision: number;
  chapterCount: number;
  revision: number;
  resourceRevisions: {
    summary: number;
    context: number;
    execution: number;
    insights: number;
    canvas: number;
    configuration: number;
    navigator: number;
  };
}

function timestampRevision(...values: Array<string | null | undefined>): number {
  return Math.max(
    1,
    ...values.map((value) => value == null ? 0 : Date.parse(value)).filter(Number.isFinite),
  );
}

/**
 * Bounded bootstrap projection over distinct bundle artifacts. It deliberately
 * does not read the conversation JSONL, runtime-event journal, snapshots or
 * large configuration catalogs; those owners are exposed by lazy resources.
 */
export class FsSessionWorkbenchBootstrapProjectionReader {
  constructor(private readonly source: FsSessionWorkbenchBootstrapSource) {}

  async read(sessionId: SessionId): Promise<FsSessionWorkbenchBootstrapProjection | null> {
    const session = await this.source.getSession(sessionId);
    if (!session) return null;

    const [goal, tasksRow, chapterCount] = await Promise.all([
      this.source.getSessionGoal(sessionId),
      this.source.getTasksRow(sessionId),
      this.source.countConversationChapters(sessionId),
    ]);
    const sessionRevision = timestampRevision(session.created_at, session.updated_at);
    const summaryRevision = timestampRevision(
      session.updated_at,
      goal?.updated_at,
      tasksRow?.updated_at,
    );
    const contextRevision = timestampRevision(session.updated_at, tasksRow?.updated_at);
    const executionRevision = timestampRevision(
      session.updated_at,
      tasksRow?.updated_at,
    );

    const resourceRevisions = {
      summary: summaryRevision,
      context: contextRevision,
      execution: executionRevision,
      insights: sessionRevision,
      canvas: sessionRevision,
      configuration: sessionRevision,
      navigator: sessionRevision,
    };

    return {
      session,
      goal,
      tasks: tasksRow?.state ?? null,
      tasksRevision: tasksRow?.revision ?? 0,
      chapterCount,
      revision: Math.max(...Object.values(resourceRevisions)),
      resourceRevisions,
    };
  }
}
