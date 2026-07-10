import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AppTddCycleResult {
  case_ids: string[];
  script: 'test:worker' | 'test:e2e';
  red_at: string | null;
  green_at: string | null;
  last_output: string;
}

interface AppTddCycleState {
  v: 1;
  cycles: Record<string, AppTddCycleResult>;
}

const EMPTY: AppTddCycleState = { v: 1, cycles: {} };

function statusPath(workspaceDir: string): string {
  return join(workspaceDir, '.app-studio', 'tdd-cycles.json');
}

export function readTddCycles(workspaceDir: string): AppTddCycleState {
  try {
    const value = JSON.parse(readFileSync(statusPath(workspaceDir), 'utf8')) as AppTddCycleState;
    return value?.v === 1 && value.cycles && typeof value.cycles === 'object' ? value : { ...EMPTY, cycles: {} };
  } catch {
    return { ...EMPTY, cycles: {} };
  }
}

export function recordTddCycle(
  workspaceDir: string,
  input: { caseIds: string[]; script: AppTddCycleResult['script']; phase: 'red' | 'green'; output: string },
): AppTddCycleState {
  const state = readTddCycles(workspaceDir);
  const now = new Date().toISOString();
  for (const caseId of input.caseIds) {
    const current = state.cycles[caseId] ?? {
      case_ids: [caseId],
      script: input.script,
      red_at: null,
      green_at: null,
      last_output: '',
    };
    state.cycles[caseId] = {
      ...current,
      script: input.script,
      red_at: input.phase === 'red' ? now : current.red_at,
      green_at: input.phase === 'green' ? now : current.green_at,
      last_output: input.output.slice(-1200),
    };
  }
  const target = statusPath(workspaceDir);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(state, null, 2) + '\n', 'utf8');
  return state;
}
