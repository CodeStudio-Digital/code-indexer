/** Host-owned recovery state. None of these callbacks is exposed to model tools. */
export interface OutcomeRecoveryIncident {
  toolUseId: string;
  toolName?: string;
  argsSummary?: string;
}

export interface OutcomeRecoverySnapshot {
  fingerprint: string;
  incidents: readonly OutcomeRecoveryIncident[];
  /** Captures the exact durable occurrences shown in this snapshot. */
  acknowledge?: () => Promise<void>;
}

export interface OutcomeRecoveryState {
  readonly toolUseIds: readonly string[];
  readonly resolvedToolUseIds?: readonly string[];
  readonly authoritative?: boolean;
  /** Cheap when no new host evidence arrived; never polls in the background. */
  refresh?: () => Promise<void>;
  subscribe?: (listener: () => void) => () => void;
  /** Register host-typed delegated/imported evidence, never model prose. */
  registerIncident?: (input: { toolUseId: string; toolName: string; args: Record<string, unknown>;
    runId?: string; sourceReference: string }) => Promise<void>;
  snapshot?: () => OutcomeRecoverySnapshot;
  /** Pending and user-reviewed signatures: progress is not an automatic replay of the old effect. */
  replayToolUseIds?: (toolName: string, input: unknown) => readonly string[];
}
