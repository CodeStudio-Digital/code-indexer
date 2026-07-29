use std::collections::HashSet;

use crate::activation_authority::ActivationAuthoritySeal;
use crate::bootstrap_limits::{
    BOOTSTRAP_SECRET_MIN_BYTES, LAUNCH_NONCE_MAX_BYTES, SESSION_TOKEN_MAX_BYTES,
};
use crate::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use crate::generated::v1 as wire;
use crate::wire_identity::identity_from_wire;

use crate::management_channel::{ManagementChannelError, ManagementSessionPolicy};

const MAX_ENDPOINTS: usize = 3;
const MAX_ENDPOINT_TEXT_BYTES: usize = 512;

pub(super) fn validate_launch(
    value: &wire::LaunchAttemptProcess,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    let identity =
        value
            .identity
            .as_ref()
            .ok_or(ManagementChannelError::InvalidManagementPayload {
                payload: "LaunchAttemptProcess",
                field: "identity",
            })?;
    identity_from_wire(identity).map_err(ManagementChannelError::InvalidIdentifier)?;
    let budget =
        value
            .resource_budget
            .as_ref()
            .ok_or(ManagementChannelError::InvalidManagementPayload {
                payload: "LaunchAttemptProcess",
                field: "resource_budget",
            })?;
    validate_budget(
        budget,
        policy,
        Some((observed_at, value.hard_deadline_at_unix_ms)),
    )?;
    if value.hard_deadline_at_unix_ms <= observed_at
        || value.authority_lease_expires_at_unix_ms <= observed_at
        || value.authority_lease_expires_at_unix_ms > value.hard_deadline_at_unix_ms
    {
        return invalid("deadlines");
    }
    if !(BOOTSTRAP_SECRET_MIN_BYTES..=LAUNCH_NONCE_MAX_BYTES).contains(&value.launch_nonce.len()) {
        return invalid("launch_nonce");
    }
    let activation_authority = value.activation_authority_seal.as_ref().ok_or(
        ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            field: "activation_authority_seal",
        },
    )?;
    ActivationAuthoritySeal::try_from(activation_authority).map_err(|_| {
        ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            field: "activation_authority_seal",
        }
    })?;
    validate_endpoints(&value.protected_endpoints)?;
    let provenance = value.expected_runner_provenance.as_ref().ok_or(
        ManagementChannelError::InvalidManagementPayload {
            payload: "LaunchAttemptProcess",
            field: "expected_runner_provenance",
        },
    )?;
    if !policy.permits_expected_runner_provenance(provenance) {
        return invalid("expected_runner_provenance");
    }
    validate_identifier(&value.idempotency_key, "idempotency_key")?;
    validate_required_limits(&value.required_enforced_limits)
}

pub(super) fn validate_budget(
    value: &wire::ResourceBudget,
    policy: &ManagementSessionPolicy,
    launch_window: Option<(i64, i64)>,
) -> Result<(), ManagementChannelError> {
    let nonzero = value.soft_memory_bytes > 0
        && value.hard_memory_bytes > 0
        && value.cpu_time_ms > 0
        && value.max_wall_ms > 0
        && value.max_processes > 0
        && value.max_threads > 0
        && value.max_open_handles > 0
        && value.max_hot_transcript_bytes > 0
        && value.max_ipc_frames > 0
        && value.max_ipc_bytes > 0
        && value.max_spool_bytes > 0
        && value.max_artifact_bytes > 0
        && value.max_concurrent_tools > 0
        && value.max_blocking_tasks > 0
        && value.cancel_grace_ms > 0;
    let within_policy = value.soft_memory_bytes <= value.hard_memory_bytes
        && value.hard_memory_bytes <= policy.limits().max_reserved_memory_bytes
        && value.max_processes <= policy.limits().max_reserved_processes
        && value.max_threads >= value.max_processes
        && value.max_artifact_bytes <= value.max_spool_bytes
        && value.cancel_grace_ms <= value.max_wall_ms;
    let within_deadline = launch_window.is_none_or(|(observed_at, deadline)| {
        deadline
            .checked_sub(observed_at)
            .and_then(|remaining| u64::try_from(remaining).ok())
            .is_some_and(|remaining| value.max_wall_ms <= remaining)
    });
    if !nonzero || !within_policy || !within_deadline {
        return invalid("resource_budget");
    }
    Ok(())
}

fn validate_endpoints(
    endpoints: &[wire::ProtectedAttemptEndpoint],
) -> Result<(), ManagementChannelError> {
    if endpoints.len() != MAX_ENDPOINTS {
        return invalid("protected_endpoints");
    }
    let mut kinds = HashSet::with_capacity(MAX_ENDPOINTS);
    let mut ids = HashSet::with_capacity(MAX_ENDPOINTS);
    let mut connections = HashSet::with_capacity(MAX_ENDPOINTS);
    for endpoint in endpoints {
        let kind = wire::AttemptEndpointKind::try_from(endpoint.kind).map_err(|_| {
            ManagementChannelError::InvalidManagementPayload {
                payload: "LaunchAttemptProcess",
                field: "endpoint_kind",
            }
        })?;
        if kind == wire::AttemptEndpointKind::Unspecified
            || !kinds.insert(kind)
            || !ids.insert(endpoint.endpoint_id.as_str())
        {
            return invalid("protected_endpoints");
        }
        validate_identifier(&endpoint.endpoint_id, "endpoint_id")?;
        validate_identifier(&endpoint.address, "endpoint_address")?;
        validate_identifier(&endpoint.connection_id, "endpoint_connection_id")?;
        if !(BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES)
            .contains(&endpoint.connection_token.len())
            || !connections.insert(endpoint.connection_id.as_str())
            || endpoint.max_frame_bytes != endpoint_frame_maximum(kind)
        {
            return invalid("protected_endpoints");
        }
    }
    Ok(())
}

const fn endpoint_frame_maximum(kind: wire::AttemptEndpointKind) -> u64 {
    match kind {
        wire::AttemptEndpointKind::Control => CONTROL_FRAME_MAX_BYTES as u64,
        wire::AttemptEndpointKind::Data => DATA_FRAME_MAX_BYTES as u64,
        wire::AttemptEndpointKind::RunnerPulse => PULSE_FRAME_MAX_BYTES as u64,
        wire::AttemptEndpointKind::Unspecified => 0,
    }
}

fn validate_required_limits(values: &[i32]) -> Result<(), ManagementChannelError> {
    if values.is_empty() {
        return invalid("required_enforced_limits");
    }
    let mut unique = HashSet::with_capacity(values.len());
    for value in values {
        let limit = wire::ResourceLimitKind::try_from(*value).map_err(|_| {
            ManagementChannelError::InvalidManagementPayload {
                payload: "LaunchAttemptProcess",
                field: "required_enforced_limits",
            }
        })?;
        if limit == wire::ResourceLimitKind::Unspecified || !unique.insert(limit) {
            return invalid("required_enforced_limits");
        }
    }
    Ok(())
}

fn validate_identifier(value: &str, field: &'static str) -> Result<(), ManagementChannelError> {
    if value.trim().is_empty()
        || value.len() > MAX_ENDPOINT_TEXT_BYTES
        || value.as_bytes().contains(&0)
    {
        return invalid(field);
    }
    Ok(())
}

const fn invalid<T>(field: &'static str) -> Result<T, ManagementChannelError> {
    Err(ManagementChannelError::InvalidManagementPayload {
        payload: "LaunchAttemptProcess",
        field,
    })
}
