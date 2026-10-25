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
  sessionId: string;
  runId: string;
  reason: string;
  at: number;
}

export interface ChatTrigger {
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
