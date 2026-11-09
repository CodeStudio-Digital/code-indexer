export interface PromptSuggestion {
  schemaVersion: 1; id: string; sessionId: string; sourceRevision: string;
  text: string; createdAt: number; expiresAt: number; costUsd: number | null;
}
export interface TaskProposal {
  schemaVersion: 1; id: string; sessionId: string; revision: number;
  title: string; prompt: string; rationale: string; sourceRevision: string;
  createdAt: number; expiresAt: number;
  state: 'pending' | 'claimed' | 'accepted' | 'started' | 'dismissed' | 'expired' | 'stale';
  context: 'fresh' | 'workspace' | 'fork';
  targetSessionId?: string; claimKey?: string; mode?: 'here' | 'new';
  startedRunId?: string;
}
export interface ScheduledTrigger {
  schemaVersion: 1; id: string; sessionId: string; revision: number;
  kind: 'once' | 'recurring'; at?: number; cron?: string; timezone: string;
  action: 'notify' | 'resume' | 'run'; prompt: string;
  misfire: 'skip' | 'fire_once' | 'ask'; overlap: 'skip' | 'coalesce';
  state: 'active' | 'paused' | 'cancelled' | 'completed' | 'needs_input';
  authorized: boolean; epoch: number; createdAt: number; expiresAt: number;
  nextDueAt: number; maxRuns: number; runs: number; lastWallTime?: string;
}
export interface ScheduledOccurrence {
  schemaVersion: 1; id: string; scheduleId: string; scheduleRevision: number;
  sessionId: string; dueAt: number; epoch: number; claimEpoch: number;
  leaseUntil: number; owner: string;
  state: 'due' | 'claimed' | 'accepted' | 'started' | 'finished' | 'missed' | 'failed' | 'cancelled' | 'outcome_unknown';
  messageId?: string; runId?: string; detail?: string;
}
