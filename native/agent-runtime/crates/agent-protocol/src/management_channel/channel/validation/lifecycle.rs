use crate::generated::v1 as wire;
use crate::wire_identity::identity_from_wire;

use crate::management_channel::{ManagementChannelError, ManagementSessionPolicy};

mod commands;
mod facts;

const MAX_CONTROL_TEXT_BYTES: usize = 512;

pub(super) use facts::{
    validate_resource_sample, validate_runtime_provenance, validate_supervisor_resource_sample,
};

pub(super) fn validate(
    body: &wire::management_payload::Body,
    policy: &ManagementSessionPolicy,
    observed_at: i64,
) -> Result<(), ManagementChannelError> {
    use wire::management_payload::Body;

    match body {
        Body::UpdateAttemptAuthority(_)
        | Body::CancelAttemptProcess(_)
        | Body::FenceAttemptProcess(_)
        | Body::ReapAttemptProcess(_)
        | Body::QuerySupervisorState(_)
        | Body::ShutdownSupervisor(_) => commands::validate(body, observed_at),
        Body::AttemptProcessSpawned(_)
        | Body::AttemptContainmentReport(_)
        | Body::AttemptProcessExited(_)
        | Body::AttemptProcessReaped(_)
        | Body::SupervisorResourceSample(_) => facts::validate(body, policy, observed_at),
        Body::HostSupervisorHello(_) | Body::SupervisorHello(_) => {
            invalid("ManagementHello", "established_channel")
        }
        _ => unreachable!("specialized management body routed to lifecycle validation"),
    }
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
