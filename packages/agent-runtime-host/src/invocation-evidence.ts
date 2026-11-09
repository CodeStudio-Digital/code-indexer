/** Additive execution evidence. Domain receipts remain authoritative. */
export interface ResourceVersion {
  projectGeneration?: string;
  structuralRevision?: number;
  semanticGeneration?: string;
  semanticRevision?: number;
  connectionRevision?: number;
  schemaRevision?: string;
}

export type InvocationOwnerV2 =
  | { kind: 'agent'; sessionId: string; runId: string; attemptId: string }
  | { kind: 'ide' | 'api' | 'cli'; interactionId: string; principalId: string };

export interface InvocationContextV2 {
  version: 2;
  invocationId: string;
  parentInvocationId?: string;
  /** Omitted by legacy adapters, never inferred from a directory or a tool name. */
  owner?: InvocationOwnerV2;
  projectId?: number;
  toolId: string;
  catalogRevision?: string;
  authorizationRevision?: string;
  deadlineAtEpochMs?: number;
  cancellationId: string;
  traceId: string;
}

export interface ResultEvidenceV2 {
  version: 2;
  invocationId: string;
  state: 'succeeded' | 'failed' | 'refused' | 'cancelled' | 'timed_out';
  effect: 'none' | 'confirmed' | 'unknown';
  completeness: 'complete' | 'partial';
  dataVersion?: ResourceVersion;
  truncations?: Array<{
    unit: 'chars' | 'bytes' | 'rows' | 'items' | 'lines';
    observed: number;
    observedExact: boolean;
    returned: number;
    reason: string;
    recovery: 'artifact' | 'cursor' | 'rerun' | 'none';
    outputRef?: string;
  }>;
  /** Only measured phases are present; total includes dispatch and policy. */
  timings: { queueMs?: number; executionMs?: number; serializationMs?: number; totalMs: number };
}

/** Closed allowlist: no input, SQL, command, path, credentials or result text. */
export interface OperationalToolEvent {
  version: 2;
  event: 'tool.finished';
  invocationId: string;
  parentInvocationId?: string;
  toolKey: string;
  source: 'native' | 'mcp' | 'other';
  state: ResultEvidenceV2['state'];
  effect: ResultEvidenceV2['effect'];
  completeness: ResultEvidenceV2['completeness'];
  durationMs: number;
  outputChars: number;
  timestamp: number;
}
