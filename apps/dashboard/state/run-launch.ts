/**
 * Single front-door to launch a run and reveal it: start the task (PTY in the
 * main process, with the project's chosen runtimes on PATH) then switch the
 * bottom panel to the Runners tab (which auto-expands and auto-selects the
 * newest task). Used by the editor gutter, the "Run File" action, and the
 * file-tree "Run with" menu.
 */

import type { RunnerManager } from '@mcp/api-bus';
import { startSnippet, startTask } from './running-tasks.js';
import { useWorkspaceLayout } from './workspace-layout.js';
import { toast } from '../components/ui/prompt-dialog.js';

export async function launchRun(input: {
  projectId: number;
  command: string;
  label: string;
  manager: RunnerManager;
  /** Project-relative working dir (defaults to project root); for nested manifests. */
  cwd?: string;
}): Promise<void> {
  try {
    await startTask(input);
    useWorkspaceLayout.getState().setActiveBottom('runners');
  } catch (e) {
    // Dynamic message only — no literal so the i18n dialog-literal guard stays green.
    toast.error(e instanceof Error ? e.message : String(e));
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
    toast.error(e instanceof Error ? e.message : String(e));
  }
}
