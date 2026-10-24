import type {
  RuntimeRouteRecord,
} from './router/types.js';

export type AgentRuntimeHostErrorCode =
  | 'invalid_routing_request'
  | 'runtime_route_conflict'
  | 'runtime_route_corrupt'
  | 'runtime_route_not_committed'
  | 'runtime_adapter_unavailable'
  | 'prepared_attempt_mismatch'
  | 'attempt_start_failed'
  | 'handle_disposed';

export class AgentRuntimeHostError extends Error {
  readonly code: AgentRuntimeHostErrorCode;

  constructor(
    code: AgentRuntimeHostErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AgentRuntimeHostError';
    this.code = code;
  }
}

export class RuntimeRouteConflictError extends AgentRuntimeHostError {
  readonly committed: RuntimeRouteRecord;
  readonly candidate: RuntimeRouteRecord;

  constructor(committed: RuntimeRouteRecord, candidate: RuntimeRouteRecord) {
    super(
      'runtime_route_conflict',
      `Attempt ${candidate.attemptId} already has a different durable runtime route`,
    );
    this.name = 'RuntimeRouteConflictError';
    this.committed = committed;
    this.candidate = candidate;
  }
}
