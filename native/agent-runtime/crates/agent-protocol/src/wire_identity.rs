use crate::generated::v1 as wire;
use crate::identity::{
    AgentRunId, AttemptId, AttemptIdentity, CommandId, CorrelationId, ExecutorOwnerId, SessionId,
};

mod error;
mod validation;

pub use error::WireIdentityError;
pub(crate) use validation::{parse_optional, parse_required, validate_required_identifier};
use validation::{
    parse_optional_uuid, parse_required_uuid, validate_optional_uuid, validate_required_uuid,
};

pub const MAX_WIRE_IDENTIFIER_BYTES: usize = 512;

/// Converts the generated wire identity into validated semantic identity.
///
/// # Errors
///
/// Rejects non-canonical operational UUIDs and missing, whitespace-only,
/// NUL-containing, or oversized identifiers.
pub fn identity_from_wire(
    value: &wire::AttemptIdentity,
) -> Result<AttemptIdentity, WireIdentityError> {
    if value.fencing_epoch == 0 {
        return Err(WireIdentityError::ZeroFencingEpoch);
    }
    Ok(AttemptIdentity {
        session_id: parse_required_uuid(&value.session_id, "session_id", |item| {
            SessionId::new(item.to_owned())
        })?,
        command_id: parse_required_uuid(&value.command_id, "command_id", |item| {
            CommandId::new(item.to_owned())
        })?,
        agent_run_id: parse_required_uuid(&value.agent_run_id, "agent_run_id", |item| {
            AgentRunId::new(item.to_owned())
        })?,
        attempt_id: parse_required_uuid(&value.attempt_id, "attempt_id", |item| {
            AttemptId::new(item.to_owned())
        })?,
        executor_owner_id: parse_required(&value.executor_owner_id, "executor_owner_id", |item| {
            ExecutorOwnerId::new(item.to_owned())
        })?,
        fencing_epoch: value.fencing_epoch,
        correlation_id: parse_required_uuid(&value.correlation_id, "correlation_id", |item| {
            CorrelationId::new(item.to_owned())
        })?,
        root_agent_run_id: parse_required_uuid(
            &value.root_agent_run_id,
            "root_agent_run_id",
            |item| AgentRunId::new(item.to_owned()),
        )?,
        owner_agent_run_id: parse_optional_uuid(
            value.owner_agent_run_id.as_deref(),
            "owner_agent_run_id",
            |item| AgentRunId::new(item.to_owned()),
        )?,
        parent_agent_run_id: parse_optional_uuid(
            value.parent_agent_run_id.as_deref(),
            "parent_agent_run_id",
            |item| AgentRunId::new(item.to_owned()),
        )?,
    })
}

/// Validates an already constructed semantic identity at an IPC boundary
/// without normalizing or cloning its identifiers.
///
/// # Errors
///
/// Rejects non-canonical operational UUIDs, whitespace-only, NUL-containing,
/// oversized identifiers and a zero fencing epoch.
pub fn validate_semantic_identity(value: &AttemptIdentity) -> Result<(), WireIdentityError> {
    validate_required_uuid(value.session_id.as_str(), "session_id")?;
    validate_required_uuid(value.command_id.as_str(), "command_id")?;
    validate_required_uuid(value.agent_run_id.as_str(), "agent_run_id")?;
    validate_required_uuid(value.attempt_id.as_str(), "attempt_id")?;
    validate_required_identifier(value.executor_owner_id.as_str(), "executor_owner_id")?;
    validate_required_uuid(value.correlation_id.as_str(), "correlation_id")?;
    validate_required_uuid(value.root_agent_run_id.as_str(), "root_agent_run_id")?;
    validate_optional_uuid(
        value.owner_agent_run_id.as_ref().map(AgentRunId::as_str),
        "owner_agent_run_id",
    )?;
    validate_optional_uuid(
        value.parent_agent_run_id.as_ref().map(AgentRunId::as_str),
        "parent_agent_run_id",
    )?;
    if value.fencing_epoch == 0 {
        return Err(WireIdentityError::ZeroFencingEpoch);
    }
    Ok(())
}

#[must_use]
pub fn identity_to_wire(value: &AttemptIdentity) -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: value.session_id.as_str().to_owned(),
        command_id: value.command_id.as_str().to_owned(),
        agent_run_id: value.agent_run_id.as_str().to_owned(),
        attempt_id: value.attempt_id.as_str().to_owned(),
        executor_owner_id: value.executor_owner_id.as_str().to_owned(),
        fencing_epoch: value.fencing_epoch,
        correlation_id: value.correlation_id.as_str().to_owned(),
        root_agent_run_id: value.root_agent_run_id.as_str().to_owned(),
        owner_agent_run_id: value
            .owner_agent_run_id
            .as_ref()
            .map(|identifier| identifier.as_str().to_owned()),
        parent_agent_run_id: value
            .parent_agent_run_id
            .as_ref()
            .map(|identifier| identifier.as_str().to_owned()),
    }
}

#[cfg(test)]
mod tests;
