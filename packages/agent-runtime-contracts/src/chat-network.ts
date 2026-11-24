import type { PresetResolution } from './ultra.js';
import type { BudgetLimits } from './ultra-work.js';

export interface ChatNetworkConfig {
  sessionId: string;
  rootId: string;
  projectId: number | null;
  enabled: boolean;
  projectIds: number[];
  role: string;
  maxSessions: number;
  maxWakeups: number;
  budgetId: string;
}

export interface ChatCompletion {
  finalText?: string | null;
  sessionId: string;
  runId: string;
  reason: string;
  at: number;
}

export interface ChatTrigger {
  journalCursorVersion?: 1;
  id: string;
  ownerSessionId: string;
  sourceSessionId: string;
  targetSessionId: string;
  event: 'completed' | 'failed' | 'finished';
  prompt: string;
  includeFinal: boolean;
  baselineRunId: string | null;
  status: 'waiting' | 'fired' | 'cancelled';
  firedRunId?: string;
  createdAt: number;
  sourceEpoch?: number;
  targetEpoch?: number;
}

export interface ChatSpawnInput {
  title: string;
  role: string;
  projectId?: number;
  provider?: string;
  model?: string;
  prompt?: string;
  start?: boolean;
}

/** HTTP snapshots shared by the host, renderer and acceptance fixtures. */
export interface ChatNetworkSnapshot {
  self: string;
  companyTeam?: { masterId: string; members: Array<{ id: string; role: string; state: string; title: string; projectId: number | null; provider: string; model: string }> };
  stopped?: boolean;
  peers: Array<{ id: string; sessionId: string; label: string; profile: string; state: string; parentId?: string }>;
  messages: Array<{ id: string; from: string; to: string; kind: string; body: string; status: string; replyTo?: string; references: string[] }>;
  candidates: Array<{ id: string; title: string }>;
  config: ChatNetworkConfig;
  links: Array<{ sessions: string[]; enabled: boolean }>;
  triggers: ChatTrigger[];
  wakeCount: number;
  rootBudget: number;
  chats: Array<{ id: string; title: string; projectId: number | null; provider: string; model: string }>;
  projects?: Array<{ id: number; name: string }>;
  policy?: PresetResolution | null;
}

export interface ChatNetworkPolicySnapshot {
  isBudgetRoot?: boolean;
  policy: PresetResolution | null;
  settings: { maxParallel?: number; maxStarts?: number };
  revision: number;
  budget: { rootId: string; starts: number; active: number; tokens: number; costUsd: number | null; uncertain: number; limits: BudgetLimits };
}
