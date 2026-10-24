import type { SupervisionState } from './state-machine.js';
/** Per-agent supervisory record. */
export interface AgentSupervisionRecord {
  agentRunId: string;
  companySessionId: string;
  role: string;
  state: SupervisionState;
  /** Wall-clock ms when the agent ENTERED the current state. */
  enteredAt: number;
  /** Wall-clock ms of the last observable event from this agent. */
  lastHeartbeatAt: number;
  /** Current tool's `tool_use_id` when state=AWAITING_TOOL. Else null. */
  currentToolUseId: string | null;
  /** Current tool's name when state=AWAITING_TOOL. Else null. */
  currentToolName: string | null;
  /** Per-state timeout override (admin / decider). Null = use default table. */
  stateTimeoutMsOverride: number | null;
  /** Count of recovery attempts since creation. */
  recoveryAttempts: number;
  /** Total incidents detected since creation. */
  incidentCount: number;
}
