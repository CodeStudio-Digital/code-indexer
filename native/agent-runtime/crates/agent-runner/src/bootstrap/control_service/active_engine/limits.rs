use super::error::ActiveEngineError;
use agent_engine::limits::EngineLimits;
use agent_protocol::generated::v1 as wire;

// Mirrors the Host provider gateway stream ceiling, independently of IPC credit.
const MAX_PROVIDER_EVENTS: usize = 100_000;

pub(super) fn execution_deadline(spec: &wire::ResolvedAttemptSpec) -> i64 {
    spec.execution_deadline_at_unix_ms
        .unwrap_or(spec.deadline_at_unix_ms)
}

pub(super) fn engine_limits(
    spec: &wire::ResolvedAttemptSpec,
    budget: wire::ResourceBudget,
) -> Result<EngineLimits, ActiveEngineError> {
    let tree = spec
        .run_tree_budget
        .as_ref()
        .ok_or(ActiveEngineError::Missing("run_tree_budget"))?;
    let context =
        usize::try_from(budget.max_ipc_bytes).map_err(|_| ActiveEngineError::InvalidLimits)?;
    let transcript = usize::try_from(budget.max_hot_transcript_bytes)
        .map_err(|_| ActiveEngineError::InvalidLimits)?;
    let event_bytes = usize::try_from(
        budget
            .max_artifact_bytes
            .min(budget.max_hot_transcript_bytes),
    )
    .map_err(|_| ActiveEngineError::InvalidLimits)?;
    EngineLimits::new(
        context,
        MAX_PROVIDER_EVENTS,
        event_bytes,
        transcript,
        tree.max_output_tokens.unwrap_or(u64::MAX),
        tree.max_cost_micros.unwrap_or(u64::MAX),
    )
    .map_err(|_| ActiveEngineError::InvalidLimits)
}

pub(super) fn capability_set_digest(
    spec: &agent_protocol::generated::v1::ResolvedAttemptSpec,
) -> Result<[u8; 32], ActiveEngineError> {
    spec.capability_set_snapshot
        .as_ref()
        .ok_or(ActiveEngineError::Missing("capability_set_snapshot"))?
        .content_sha256
        .as_slice()
        .try_into()
        .map_err(|_| ActiveEngineError::CapabilityAuthority)
}
