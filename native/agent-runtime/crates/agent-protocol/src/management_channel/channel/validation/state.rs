use std::collections::HashSet;

use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_channel::{ManagementChannelError, ManagementSessionPolicy};

use super::{bounded_time, invalid, lifecycle, required_identity, valid_text};

pub(super) fn validate(
    value: &wire::SupervisorState,
    policy: &ManagementSessionPolicy,
    connection: &ConnectionId,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    if value.connection_id != connection.as_str()
        || value.attempts.len() > policy.limits().max_active_attempts as usize
    {
        return invalid("SupervisorState", "connection_or_attempt_count");
    }
    let mut attempt_ids = HashSet::with_capacity(value.attempts.len());
    for attempt in &value.attempts {
        validate_snapshot(attempt, policy, observed_at, &mut attempt_ids)?;
    }
    if let Some(resources) = value.resources.as_ref() {
        lifecycle::validate_supervisor_resource_sample(resources, policy, observed_at)?;
    }
    bounded_time(
        value.observed_at_unix_ms,
        observed_at,
        "SupervisorState",
        "observed_at",
    )
}

fn validate_snapshot<'a>(
    attempt: &'a wire::AttemptProcessSnapshot,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
    attempt_ids: &mut HashSet<&'a str>,
) -> Result<(), ManagementChannelError> {
    let identity = required_identity(attempt.identity.as_ref(), "AttemptProcessSnapshot")?;
    lifecycle::validate_runtime_provenance(
        attempt.runner_provenance.as_ref(),
        policy,
        "AttemptProcessSnapshot",
    )?;
    valid_text(
        &attempt.resource_group_id,
        "AttemptProcessSnapshot",
        "resource_group_id",
    )?;
    let phase = wire::AttemptProcessPhase::try_from(attempt.phase).map_err(|_| {
        ManagementChannelError::InvalidManagementPayload {
            payload: "AttemptProcessSnapshot",
            field: "phase",
        }
    })?;
    if phase == wire::AttemptProcessPhase::Unspecified
        || attempt.hard_deadline_at_unix_ms <= 0
        || attempt.authority_lease_expires_at_unix_ms <= 0
        || attempt.authority_lease_expires_at_unix_ms > attempt.hard_deadline_at_unix_ms
    {
        return invalid("AttemptProcessSnapshot", "phase_or_deadlines");
    }
    bounded_time(
        attempt.last_pulse_at_unix_ms,
        observed_at,
        "AttemptProcessSnapshot",
        "last_pulse_at",
    )?;
    if let Some(resources) = attempt.resources.as_ref() {
        lifecycle::validate_resource_sample(
            Some(resources),
            "AttemptProcessSnapshot",
            "resources",
        )?;
    }
    if !attempt_ids.insert(identity.attempt_id.as_str()) {
        return invalid("SupervisorState", "duplicate_attempt");
    }
    Ok(())
}
