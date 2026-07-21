/**
 * Single front-door to launch a run and reveal it: start the task (PTY in the
 * main process, with the project's chosen runtimes on PATH) then switch the
 * bottom panel to the Runners tab (which auto-expands and auto-selects the
 * newest task). Used by the editor gutter, the "Run File" action, and the
 * file-tree "Run with" menu.
 */

import type { FileRunTarget, RunnerManager, RuntimeTarget } from '@mcp/api-bus';
import { apiCall } from '../lib/api-client.js';
import { startSnippet, startTask } from './running-tasks.js';
import { useWorkspaceLayout } from './workspace-layout.js';
import { recordExecutionFailure } from './execution-output.js';
import { toast } from '../components/ui/prompt-dialog.js';

export async function launchRun(input: {
  projectId: number;
  command: string;
  label: string;
  manager: RunnerManager;
  /** Project-relative working dir (defaults to project root); for nested manifests. */
  cwd?: string;
  /** Explicit host/WSL environment; omitted to follow the project's runner shell. */
  target?: RuntimeTarget;
}): Promise<void> {
  try {
    await startTask(input);
    useWorkspaceLayout.getState().setActiveBottom('runners');
  } catch (e) {
    // Dynamic message only — no literal so the i18n dialog-literal guard stays green.
    useWorkspaceLayout.getState().setActiveBottom('output');
    toast.error(e instanceof Error ? e.message : String(e));
  }
}

/** Resolve repository-controlled paths/script names on the backend, then run. */
export async function launchFileRun(input: {
  projectId: number;
  file: string;
  content?: string;
  script?: string;
  label?: string;
  target?: RuntimeTarget;
}): Promise<void> {
  try {
    const target = await apiCall<FileRunTarget>('runner.fileRunTarget', input);
    if (!target.command) {
      if (target.reason) toast.error(target.reason);
      return;
    }
    await launchRun({
      projectId: input.projectId,
      command: target.command,
      label: input.label ?? target.label,
      manager: target.manager,
      cwd: target.cwd,
      target: input.target,
    });
  } catch (error) {
    recordExecutionFailure({
      projectId: input.projectId,
      source: 'runner',
      label: input.label ?? `Run ${input.file}`,
      command: input.script ? `resolve ${input.script}` : `resolve ${input.file}`,
      error,
    });
    useWorkspaceLayout.getState().setActiveBottom('output');
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Run a markdown fenced code block (the editor markdown gutter): the backend
 * materialises the snippet to a temp file and runs it with the project's
 * runtime on PATH. Then reveal the Runners tab. Mirrors `launchRun`.
 */
export async function launchSnippet(input: {
  projectId: number;
  language: string;
  code: string;
  label: string;
}): Promise<void> {
  try {
    await startSnippet(input);
    useWorkspaceLayout.getState().setActiveBottom('runners');
  } catch (e) {
    useWorkspaceLayout.getState().setActiveBottom('output');
    toast.error(e instanceof Error ? e.message : String(e));
  }
}
