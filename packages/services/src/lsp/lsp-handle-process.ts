import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setPriority } from 'node:os';
import { trackProcessTree } from '@mcp/shared/utils/process-tree.js';

interface LspProcessSpec {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  priority?: number;
}

export interface SpawnedLspProcess {
  child: ChildProcessWithoutNullStreams;
  untrack: () => void;
}

/** Spawn a clean language-server process without inheriting app/dev loaders. */
export function spawnLspProcess(
  spec: LspProcessSpec,
  log: (message: string) => void,
): SpawnedLspProcess {
  const inherited: NodeJS.ProcessEnv = { ...process.env };
  delete inherited.NODE_OPTIONS;
  delete inherited.JAVA_TOOL_OPTIONS;
  delete inherited._JAVA_OPTIONS;
  delete inherited.JDK_JAVA_OPTIONS;
  const child = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...inherited, ...spec.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    shell: false,
  });
  const untrack = trackProcessTree(child.pid);
  if (spec.priority !== undefined && child.pid !== undefined) {
    try {
      setPriority(child.pid, spec.priority);
    } catch (error) {
      log(`could not lower process priority: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { child, untrack };
}
