use crate::generated::v1 as wire;
use crate::identity::{ConnectionId, MessageId};
use crate::version::ProtocolVersion;
use crate::wire_identity::{parse_optional, parse_required};

use super::ManagementChannelError;

pub(super) struct ValidatedManagementHeader {
    pub wire: wire::ManagementFrameHeader,
    pub protocol: ProtocolVersion,
    pub connection: ConnectionId,
    pub message_id: String,
}

pub(super) fn validate_management_header(
    header: wire::ManagementFrameHeader,
) -> Result<ValidatedManagementHeader, ManagementChannelError> {
    let protocol = ProtocolVersion::from_wire(header.protocol_version);
    if protocol.major == 0 {
        return Err(ManagementChannelError::InvalidProtocolVersion(
            header.protocol_version,
        ));
    }
    let connection = parse_required(&header.connection_id, "connection_id", |value| {
        ConnectionId::new(value.to_owned())
    })
    .map_err(ManagementChannelError::InvalidIdentifier)?;
    let message_id = parse_required(&header.message_id, "message_id", |value| {
        MessageId::new(value.to_owned())
    })
    .map_err(ManagementChannelError::InvalidIdentifier)?;
    parse_optional(
        header.reply_to_message_id.as_deref(),
        "reply_to_message_id",
        |value| MessageId::new(value.to_owned()),
    )
    .map_err(ManagementChannelError::InvalidIdentifier)?;
    if header.stream_seq == 0 {
        return Err(ManagementChannelError::ZeroStreamSequence);
    }
    if header.sent_at_unix_ms <= 0 {
        return Err(ManagementChannelError::InvalidSentAt(
            header.sent_at_unix_ms,
        ));
    }
    if let Some(deadline_at) = header.deadline_at_unix_ms
        && (deadline_at <= 0 || deadline_at <= header.sent_at_unix_ms)
    {
        return Err(ManagementChannelError::InvalidDeadline {
            sent_at: header.sent_at_unix_ms,
            deadline_at,
        });
    }
    Ok(ValidatedManagementHeader {
        wire: header,
        protocol,
        connection,
        message_id: message_id.as_str().to_owned(),
    })
}
