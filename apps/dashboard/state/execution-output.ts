/**
 * Renderer-side history for finite project operations that do not own a PTY
 * (notably Git RPCs) and for failures that happen before a runner/debug
 * process can be registered. Long-running runner output remains authoritative
 * in PtyManager; DAP output remains authoritative in the debug session store.
 */
import { create } from 'zustand';
import type { DebugSessionSummary } from '@mcp/api-bus';

export type ExecutionOutputSource = 'git' | 'runner' | 'debug';
export type ExecutionOutputStatus = 'running' | 'succeeded' | 'failed';

export interface ExecutionOutputEntry {
  id: string;
  projectId: number;
  source: ExecutionOutputSource;
  label: string;
  command: string;
  status: ExecutionOutputStatus;
  output: string;
  startedAt: number;
  completedAt?: number;
}

interface ExecutionOutputState {
  entries: ExecutionOutputEntry[];
  begin: (entry: Omit<ExecutionOutputEntry, 'id' | 'startedAt'> & { startedAt?: number }) => string;
  finish: (
    id: string,
    update: Pick<ExecutionOutputEntry, 'status' | 'output'> & Partial<Pick<ExecutionOutputEntry, 'label' | 'command'>>,
  ) => void;
  clearProject: (projectId: number) => void;
  reset: () => void;
}

const MAX_RETAINED_ENTRIES = 100;
let nextEntryId = 0;

export const useExecutionOutput = create<ExecutionOutputState>((set) => ({
  entries: [],
  begin: (entry) => {
    const startedAt = entry.startedAt ?? Date.now();
    const id = `${entry.source}:${startedAt}:${++nextEntryId}`;
    set((state) => ({
      entries: [...state.entries, { ...entry, id, startedAt }].slice(-MAX_RETAINED_ENTRIES),
    }));
    return id;
  },
  finish: (id, update) => set((state) => ({
    entries: state.entries.map((entry) => entry.id === id
      ? { ...entry, ...update, completedAt: Date.now() }
      : entry),
  })),
  clearProject: (projectId) => set((state) => ({
    entries: state.entries.filter((entry) => entry.projectId !== projectId),
  })),
  reset: () => set({ entries: [] }),
}));

export function beginExecution(
  entry: Omit<ExecutionOutputEntry, 'id' | 'startedAt'> & { startedAt?: number },
): string {
  return useExecutionOutput.getState().begin(entry);
}

export function finishExecution(
  id: string,
  update: Pick<ExecutionOutputEntry, 'status' | 'output'> & Partial<Pick<ExecutionOutputEntry, 'label' | 'command'>>,
): void {
  useExecutionOutput.getState().finish(id, update);
}

export function recordExecutionFailure(input: {
  projectId: number;
  source: ExecutionOutputSource;
  label: string;
  command: string;
  error: unknown;
}): string {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const id = beginExecution({
    projectId: input.projectId,
    source: input.source,
    label: input.label,
    command: input.command,
    status: 'running',
    output: `$ ${input.command}\r\n`,
  });
  finishExecution(id, {
    status: 'failed',
    output: `$ ${input.command}\r\n${message}\r\n`,
  });
  return id;
}

export function executionEntriesForProject(
  entries: ExecutionOutputEntry[],
  projectId: number,
): ExecutionOutputEntry[] {
  return entries.filter((entry) => entry.projectId === projectId);
}

export function terminalOutputEol(value: string): string {
  if (!value) return '';
  const normalized = value.replace(/\r?\n/g, '\r\n');
  return normalized.endsWith('\r\n') ? normalized : `${normalized}\r\n`;
}

/** Turn the retained DAP output plus startup/connection error into one log. */
export function debugSessionOutput(session: DebugSessionSummary): string {
  let output = `$ debug ${session.name}\r\n`;
  for (const line of session.output) {
    if (line.category && !['stdout', 'console'].includes(line.category)) {
      output += `[${line.category}] `;
    }
    output += terminalOutputEol(line.output);
  }
  if (session.error) output += `\r\n[error]\r\n${terminalOutputEol(session.error)}`;
  if (session.state === 'terminated' || session.exitCode != null) {
    output += `[process exited code=${session.exitCode ?? '?'}]\r\n`;
  }
  return output;
}
