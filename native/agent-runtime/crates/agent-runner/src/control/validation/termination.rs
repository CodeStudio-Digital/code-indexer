use agent_protocol::generated::v1 as wire;
use agent_protocol::wire_identity::identity_from_wire;

use super::{validate_control_size, validate_text};
use crate::control::error::ControlError;
use crate::control::launch::RunnerLaunchContext;
use crate::control::model::{CancelledAttempt, FencedAttempt};
use crate::control::{MAX_IDEMPOTENCY_KEY_BYTES, MAX_REASON_CODE_BYTES};

pub(in crate::control) fn validate_cancel(
    request: &wire::CancelAttempt,
    launch: &RunnerLaunchContext,
    effective_deadline_at_unix_ms: i64,
    observed_at_unix_ms: i64,
) -> Result<CancelledAttempt, ControlError> {
    validate_control_size(request)?;
    validate_identity(request.identity.as_ref(), launch)?;
    validate_text(&request.idempotency_key, MAX_IDEMPOTENCY_KEY_BYTES)
        .map_err(ControlError::InvalidIdempotencyKey)?;
    validate_reason_code(&request.reason_code)?;

    let reason = wire::CancelReason::try_from(request.reason)
        .map_err(|_| ControlError::InvalidCancelAttempt("reason is unknown"))?;
    if reason == wire::CancelReason::Unspecified {
        return Err(ControlError::InvalidCancelAttempt(
            "reason must be specified",
        ));
    }
    if observed_at_unix_ms <= 0 {
        return Err(ControlError::InvalidCancelAttempt(
            "observed timestamp must be positive",
        ));
    }
    let grace_ms = i64::try_from(launch.resource_budget().cancel_grace_ms).unwrap_or(i64::MAX);
    let maximum_grace_deadline =
        effective_deadline_at_unix_ms.min(observed_at_unix_ms.saturating_add(grace_ms));
    if request.grace_deadline_at_unix_ms <= observed_at_unix_ms
        || request.grace_deadline_at_unix_ms > maximum_grace_deadline
    {
        return Err(ControlError::InvalidCancelAttempt(
            "grace deadline exceeds sealed authority",
        ));
    }

    Ok(CancelledAttempt::new(
        reason,
        request.reason_code.clone(),
        request.grace_deadline_at_unix_ms,
    ))
}

pub(in crate::control) fn validate_fence(
    request: &wire::FenceAttempt,
    launch: &RunnerLaunchContext,
    observed_at_unix_ms: i64,
) -> Result<FencedAttempt, ControlError> {
    validate_control_size(request)?;
    validate_identity(request.identity.as_ref(), launch)?;
    validate_text(&request.idempotency_key, MAX_IDEMPOTENCY_KEY_BYTES)
        .map_err(ControlError::InvalidIdempotencyKey)?;
    validate_reason_code(&request.reason_code)?;

    if request.replacement_fencing_epoch <= launch.identity().fencing_epoch {
        return Err(ControlError::InvalidFenceAttempt(
            "replacement fencing epoch is not newer",
        ));
    }
    if request.fenced_at_unix_ms <= 0 || request.fenced_at_unix_ms > observed_at_unix_ms {
        return Err(ControlError::InvalidFenceAttempt(
            "fenced timestamp is outside the receive window",
        ));
    }

    Ok(FencedAttempt::new(
        request.replacement_fencing_epoch,
        request.reason_code.clone(),
        request.fenced_at_unix_ms,
    ))
}

fn validate_identity(
    value: Option<&wire::AttemptIdentity>,
    launch: &RunnerLaunchContext,
) -> Result<(), ControlError> {
    let value = value.ok_or(ControlError::MissingIdentity)?;
    let identity = identity_from_wire(value).map_err(ControlError::InvalidIdentity)?;
    if value != launch.wire_identity() || &identity != launch.identity() {
        return Err(ControlError::TerminationIdentityMismatch);
    }
    Ok(())
}

fn validate_reason_code(value: &str) -> Result<(), ControlError> {
    validate_text(value, MAX_REASON_CODE_BYTES)
        .map_err(ControlError::InvalidTerminationReasonCode)?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(ControlError::InvalidTerminationReasonCodeCharacters);
    }
    Ok(())
}
