import type { AgentMessage } from '../core/messages.js';

export interface ChatCheckpoint {
  schemaVersion?: 3;
  execution?: import('@mcp/agent-runtime-contracts').ExecutionSnapshot;
  fence?: import('@mcp/session-storage/fs-store/index.js').FsSubagentRunFence;
  actor: string;
  spawnId: string;
  chatKey?: string;
  profile: string;
  label: string;
  cwd: string;
  transcript: AgentMessage[];
  files?: string[];
  outcomeUnknown?: boolean;
  phase?: 'running' | 'committing' | 'complete';
  ownerPid?: number;
  workspaceReady?: boolean;
}
