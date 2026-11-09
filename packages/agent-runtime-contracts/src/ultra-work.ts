/** Host-owned work contracts. Agent prose cannot grant authority or mark an effect reconciled. */
export interface AgentWorkResult {
  schemaVersion: 1;
  status: 'completed' | 'partial' | 'failed' | 'needs_input' | 'cancelled';
  summary: string;
  evidence: Array<{ kind: 'test' | 'inspection' | 'artifact'; reference: string; outcome: 'passed' | 'failed' | 'unverified' }>;
  artifacts: string[];
  acceptance: 'accepted' | 'unverified' | 'rejected';
  criteria?: Array<{ text: string; status: 'met' | 'unmet' | 'unverified'; evidence: string[] }>;
  effectOutcome: 'confirmed' | 'unknown';
}

export interface WorkWaitResult<T> {
  schemaVersion: 1;
  reason: 'completed' | 'response' | 'idle' | 'timeout' | 'aborted' | 'cancelled' | 'expired' | 'cycle_detected' | 'cursor_expired';
  items: T[];
  cursor: string | null;
}

export interface ExecutionSnapshot {
  schemaVersion: 1;
  provider: string;
  model: string;
  effort?: string;
  maxTurns: number;
  limits?: { maxToolCalls?: number; timeoutMs?: number; stallMs?: number };
  profile: string;
  workspace: string;
  inputDigest: string;
  policyVersion: string;
  runId: string;
  instanceId: string;
  epoch: number;
}

export interface BudgetLimits {
  maxParallel: number;
  maxStarts: number;
  maxTokens?: number;
  maxCostUsd?: number;
}

export interface DiscoveryReceipt {
  schemaVersion: 1;
  revision: string;
  tools: Array<{ name: string; state: 'callable' | 'activated' | 'pending' | 'deferred' | 'denied' | 'unavailable'; reason?: string }>;
}

export interface DelegationContext {
  schemaVersion: 1;
  objective: string;
  acceptance: string[];
  fileScope: string[];
  inputDigest: string;
  policyVersion: string;
  budgetId?: string;
  exclusions: string[];
}
