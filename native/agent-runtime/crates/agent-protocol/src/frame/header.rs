use crate::generated::v1 as wire;
use crate::identity::{ConnectionId, MessageId, OperationId};
use crate::version::ProtocolVersion;
use crate::wire_identity::{identity_from_wire, parse_optional, parse_required};

use super::FrameHeaderError;

#[derive(Debug)]
pub(super) struct ValidatedFrameHeader {
    pub wire: wire::FrameHeader,
    pub protocol_version: ProtocolVersion,
    pub connection_id: ConnectionId,
    pub message_id: MessageId,
    pub identity: crate::identity::AttemptIdentity,
}

pub(super) fn validate_frame_header(
    header: wire::FrameHeader,
) -> Result<ValidatedFrameHeader, FrameHeaderError> {
    let protocol_version = ProtocolVersion::from_wire(header.protocol_version);
    if protocol_version.major == 0 {
        return Err(FrameHeaderError::InvalidProtocolVersion(
            header.protocol_version,
        ));
    }

    let connection_id = parse_required(&header.connection_id, "connection_id", |value| {
        ConnectionId::new(value.to_owned())
    })
    .map_err(FrameHeaderError::InvalidIdentifier)?;
    let message_id = parse_required(&header.message_id, "message_id", |value| {
        MessageId::new(value.to_owned())
    })
    .map_err(FrameHeaderError::InvalidIdentifier)?;
    parse_optional(
        header.reply_to_message_id.as_deref(),
        "reply_to_message_id",
        |value| MessageId::new(value.to_owned()),
    )
    .map_err(FrameHeaderError::InvalidIdentifier)?;
    parse_optional(header.operation_id.as_deref(), "operation_id", |value| {
        OperationId::new(value.to_owned())
    })
    .map_err(FrameHeaderError::InvalidIdentifier)?;
    parse_optional(header.tool_use_id.as_deref(), "tool_use_id", |value| {
        MessageId::new(value.to_owned())
    })
    .map_err(FrameHeaderError::InvalidIdentifier)?;

    if header.fencing_epoch == 0 {
        return Err(FrameHeaderError::ZeroFencingEpoch);
    }
    if header.stream_seq == 0 {
        return Err(FrameHeaderError::ZeroStreamSequence);
    }
    if header.sent_at_unix_ms <= 0 {
        return Err(FrameHeaderError::InvalidSentAt(header.sent_at_unix_ms));
    }
    if let Some(deadline_at) = header.deadline_at_unix_ms
        && (deadline_at <= 0 || deadline_at <= header.sent_at_unix_ms)
    {
        return Err(FrameHeaderError::InvalidDeadline {
            sent_at: header.sent_at_unix_ms,
            deadline_at,
        });
    }

    let identity = identity_from_wire(&wire::AttemptIdentity {
        session_id: header.session_id.clone(),
        command_id: header.command_id.clone(),
        agent_run_id: header.agent_run_id.clone(),
        attempt_id: header.attempt_id.clone(),
        executor_owner_id: header.executor_owner_id.clone(),
        fencing_epoch: header.fencing_epoch,
        correlation_id: header.correlation_id.clone(),
        root_agent_run_id: header.root_agent_run_id.clone(),
        owner_agent_run_id: header.owner_agent_run_id.clone(),
        parent_agent_run_id: header.parent_agent_run_id.clone(),
    })
    .map_err(FrameHeaderError::InvalidIdentifier)?;

    Ok(ValidatedFrameHeader {
        wire: header,
        protocol_version,
        connection_id,
        message_id,
        identity,
    })
}
