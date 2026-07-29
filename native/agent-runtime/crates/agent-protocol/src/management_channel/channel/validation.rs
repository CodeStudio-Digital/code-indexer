use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::wire_identity::identity_from_wire;

use crate::management_channel::{ManagementChannelError, ManagementSessionPolicy};

mod correlation;
mod launch;
mod lifecycle;
mod state;

pub(in crate::management_channel) use correlation::validate_response_correlation;

const MAX_CONTROL_TEXT_BYTES: usize = 512;

pub(in crate::management_channel) fn validate_management_body(
    policy: &ManagementSessionPolicy,
    connection: &ConnectionId,
    body: &wire::management_payload::Body,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    use wire::management_payload::Body;

    match body {
        Body::LaunchAttemptProcess(value) => launch::validate_launch(value, policy, observed_at),
        Body::LaunchAccepted(value) => validate_launch_accepted(value, policy, observed_at),
        Body::LaunchRejected(value) => validate_launch_rejected(value, observed_at),
        Body::SupervisorState(value) => state::validate(value, policy, connection, observed_at),
        Body::SupervisorFault(value) => validate_supervisor_fault(value, observed_at),
        Body::ManagementAck(value) => validate_ack(value, observed_at),
        _ => lifecycle::validate(body, policy, observed_at),
    }
}

fn validate_launch_accepted(
    value: &wire::LaunchAccepted,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    required_identity(value.identity.as_ref(), "LaunchAccepted")?;
    valid_text(&value.reservation_id, "LaunchAccepted", "reservation_id")?;
    let budget =
        value
            .reserved_budget
            .as_ref()
            .ok_or(ManagementChannelError::InvalidManagementPayload {
                payload: "LaunchAccepted",
                field: "reserved_budget",
            })?;
    launch::validate_budget(budget, policy, None)?;
    if value.accepted_at_unix_ms <= 0
        || value.accepted_at_unix_ms > observed_at
        || value.hard_deadline_at_unix_ms <= value.accepted_at_unix_ms
    {
        return invalid("LaunchAccepted", "timestamps");
    }
    Ok(())
}

fn validate_launch_rejected(
    value: &wire::LaunchRejected,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    required_identity(value.identity.as_ref(), "LaunchRejected")?;
    if wire::LaunchRejectionReason::try_from(value.reason).is_err()
        || value.reason == wire::LaunchRejectionReason::Unspecified as i32
    {
        return invalid("LaunchRejected", "reason");
    }
    valid_code(&value.reason_code, "LaunchRejected", "reason_code")?;
    if value.redacted_detail.is_some() {
        return invalid("LaunchRejected", "redacted_detail_v1_forbidden");
    }
    bounded_time(
        value.rejected_at_unix_ms,
        observed_at,
        "LaunchRejected",
        "rejected_at",
    )
}

fn validate_supervisor_fault(
    value: &wire::SupervisorFault,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    let valid_scope = wire::SupervisorFaultScope::try_from(value.scope)
        .is_ok_and(|scope| scope != wire::SupervisorFaultScope::Unspecified);
    let valid_severity = wire::SupervisorFaultSeverity::try_from(value.severity)
        .is_ok_and(|severity| severity != wire::SupervisorFaultSeverity::Unspecified);
    if !valid_scope || !valid_severity {
        return invalid("SupervisorFault", "scope_or_severity");
    }
    if let Some(identity) = &value.identity {
        identity_from_wire(identity).map_err(ManagementChannelError::InvalidIdentifier)?;
    }
    valid_code(&value.fault_code, "SupervisorFault", "fault_code")?;
    if value.redacted_detail.is_some() {
        return invalid("SupervisorFault", "redacted_detail_v1_forbidden");
    }
    bounded_time(
        value.occurred_at_unix_ms,
        observed_at,
        "SupervisorFault",
        "occurred_at",
    )
}

fn validate_ack(
    value: &wire::ManagementAck,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    valid_text(
        &value.acknowledged_message_id,
        "ManagementAck",
        "acknowledged_message_id",
    )?;
    if value.acknowledged_payload_sha256.len() != 32 {
        return invalid("ManagementAck", "acknowledged_payload_sha256");
    }
    bounded_time(
        value.acknowledged_at_unix_ms,
        observed_at,
        "ManagementAck",
        "acknowledged_at",
    )
}

fn required_identity<'a>(
    value: Option<&'a wire::AttemptIdentity>,
    payload: &'static str,
) -> Result<&'a wire::AttemptIdentity, ManagementChannelError> {
    let value = value.ok_or(ManagementChannelError::InvalidManagementPayload {
        payload,
        field: "identity",
    })?;
    identity_from_wire(value).map_err(ManagementChannelError::InvalidIdentifier)?;
    Ok(value)
}

fn valid_text(
    value: &str,
    payload: &'static str,
    field: &'static str,
) -> Result<(), ManagementChannelError> {
    if value.trim().is_empty()
        || value.len() > MAX_CONTROL_TEXT_BYTES
        || value.as_bytes().contains(&0)
    {
        return invalid(payload, field);
    }
    Ok(())
}

fn valid_code(
    value: &str,
    payload: &'static str,
    field: &'static str,
) -> Result<(), ManagementChannelError> {
    valid_text(value, payload, field)?;
    if value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return invalid(payload, field);
    }
    Ok(())
}

const fn bounded_time(
    value: i64,
    observed_at: i64,
    payload: &'static str,
    field: &'static str,
) -> Result<(), ManagementChannelError> {
    if value <= 0 || value > observed_at {
        return invalid(payload, field);
    }
    Ok(())
}

const fn invalid<T>(
    payload: &'static str,
    field: &'static str,
) -> Result<T, ManagementChannelError> {
    Err(ManagementChannelError::InvalidManagementPayload { payload, field })
}
