import type {
  AgentRun,
  AgentRunTerminalStatus,
  SessionCommandStatus,
} from '@mcp/agent-runtime-contracts';
import {
  classifyCoderTerminalOutcome,
  isTerminalAgentRunStatus,
} from '@mcp/agent-runtime-contracts';
import type { PersistedSessionCommand } from './types.js';

/** Terminal signal observed by the legacy bus at end-of-run. */
export interface LegacyTerminalState {
  event: 'done' | 'error';
  reason: string;
}

export type DivergenceKind =
  | 'missing_command'
  | 'missing_run'
  | 'command_not_terminal'
  | 'run_not_terminal'
  | 'command_status_mismatch'
  | 'run_status_mismatch';

export interface StateDivergence {
  kind: DivergenceKind;
  legacyState: Record<string, unknown>;
  controlPlaneState: Record<string, unknown>;
  detail: string;
}

interface ExpectedTerminal {
  runStatuses: AgentRunTerminalStatus[];
  commandStatuses: SessionCommandStatus[];
}

/**
 * Maps the legacy bus terminal signal to the control-plane terminal states it
 * must correspond to using the same reason classifier as the worker and
 * command ledger.
 */
function expectedTerminal(legacy: LegacyTerminalState): ExpectedTerminal {
  const terminal = classifyCoderTerminalOutcome(legacy);
  switch (terminal.classification) {
    case 'completed':
      return { runStatuses: ['completed'], commandStatuses: ['succeeded'] };
    case 'cancelled':
      return { runStatuses: ['aborted'], commandStatuses: ['cancelled'] };
    case 'interrupted':
      return { runStatuses: ['interrupted'], commandStatuses: ['failed'] };
    case 'failed':
      // Infrastructure failures are intentionally projected as interrupted
      // when their executor lease is fenced, while semantic runner failures
      // project as failed. Both remain failed commands.
      return { runStatuses: ['failed', 'interrupted'], commandStatuses: ['failed'] };
  }
}

function legacyStateJson(legacy: LegacyTerminalState): Record<string, unknown> {
  return { event: legacy.event, reason: legacy.reason };
}

/**
 * Pure comparator (Fase 1D): after a legacy terminal event, the shadow
 * control plane must hold a terminal, status-compatible command and run.
 * Returns an empty list when the states agree. Redacted by construction —
 * only statuses/reasons are captured, never payloads.
 */
export function compareRunTerminalState(input: {
  legacy: LegacyTerminalState;
  command: Pick<PersistedSessionCommand, 'status' | 'reasonCode' | 'agentRunId'> | null;
  run: Pick<AgentRun, 'status' | 'terminalReason'> | null;
}): StateDivergence[] {
  const { legacy, command, run } = input;
  const expected = expectedTerminal(legacy);
  const divergences: StateDivergence[] = [];
  const legacyJson = legacyStateJson(legacy);

  if (!command) {
    divergences.push({
      kind: 'missing_command',
      legacyState: legacyJson,
      controlPlaneState: {},
      detail: 'legacy run reached a terminal state but no control-plane command exists',
    });
    return divergences;
  }

  const commandJson: Record<string, unknown> = {
    status: command.status,
    reasonCode: command.reasonCode ?? null,
  };
  const commandIsTerminal = !['accepted', 'running'].includes(command.status);
  if (!commandIsTerminal) {
    divergences.push({
      kind: 'command_not_terminal',
      legacyState: legacyJson,
      controlPlaneState: commandJson,
      detail: `command is ${command.status}, expected one of ${expected.commandStatuses.join('|')}`,
    });
  } else if (!expected.commandStatuses.includes(command.status)) {
    divergences.push({
      kind: 'command_status_mismatch',
      legacyState: legacyJson,
      controlPlaneState: commandJson,
      detail: `command status ${command.status}, expected one of ${expected.commandStatuses.join('|')}`,
    });
  }

  if (!command.agentRunId) return divergences;
  if (!run) {
    divergences.push({
      kind: 'missing_run',
      legacyState: legacyJson,
      controlPlaneState: commandJson,
      detail: `command references AgentRun ${command.agentRunId} but no control-plane run exists`,
    });
    return divergences;
  }

  const runJson: Record<string, unknown> = {
    status: run.status,
    terminalReason: run.terminalReason ?? null,
  };
  if (!isTerminalAgentRunStatus(run.status)) {
    divergences.push({
      kind: 'run_not_terminal',
      legacyState: legacyJson,
      controlPlaneState: runJson,
      detail: `run is ${run.status}, expected one of ${expected.runStatuses.join('|')}`,
    });
  } else if (!expected.runStatuses.includes(run.status)) {
    divergences.push({
      kind: 'run_status_mismatch',
      legacyState: legacyJson,
      controlPlaneState: runJson,
      detail: `run status ${run.status}, expected one of ${expected.runStatuses.join('|')}`,
    });
  }
  return divergences;
}
