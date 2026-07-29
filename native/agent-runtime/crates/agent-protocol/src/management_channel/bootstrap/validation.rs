use zeroize::Zeroize;

use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_frame::{MANAGEMENT_FRAME_MAX_BYTES, validate_management_frame};

use super::ManagementBootstrapHello;
use super::policy::{
    BootstrapSelection, SecretDigest, validate_host_hello, validate_supervisor_hello,
};
use crate::management_channel::header::validate_management_header;
use crate::management_channel::{ManagementChannelError, ManagementDirection, management_hard_cap};

pub(in crate::management_channel) struct ReceivedBootstrap {
    pub message_id: String,
    pub hello: ManagementBootstrapHello,
    pub selection: Option<BootstrapSelection>,
}

pub(in crate::management_channel) fn validate_wire_bootstrap(
    bytes: &[u8],
    connection: &ConnectionId,
    direction: ManagementDirection,
    selection: Option<&BootstrapSelection>,
    expected_launch_nonce: SecretDigest,
    expected_management_token: SecretDigest,
    observed_at: i64,
) -> Result<ReceivedBootstrap, ManagementChannelError> {
    if observed_at <= 0 {
        return Err(ManagementChannelError::InvalidObservedAt(observed_at));
    }
    if bytes.len() > management_hard_cap() {
        return Err(ManagementChannelError::FrameTooLarge {
            length: bytes.len(),
            maximum: MANAGEMENT_FRAME_MAX_BYTES,
        });
    }
    let mut validated = validate_management_frame(bytes)?;
    let header = validate_management_header(
        validated
            .frame
            .header
            .take()
            .ok_or(crate::management_frame::ManagementFrameError::MissingHeader)?,
    )?;
    if &header.connection != connection {
        return Err(ManagementChannelError::ConnectionMismatch);
    }
    if header.wire.stream_seq != 1 {
        return Err(ManagementChannelError::SequenceMismatch {
            expected: 1,
            actual: header.wire.stream_seq,
        });
    }
    if let Some(expected) = selection
        && header.protocol != expected.protocol
    {
        return Err(ManagementChannelError::ProtocolMismatch);
    }
    if let Some(deadline_at) = header.wire.deadline_at_unix_ms
        && observed_at >= deadline_at
    {
        return Err(ManagementChannelError::DeadlineExpired {
            deadline_at,
            observed_at,
        });
    }
    let body = validated
        .payload
        .body
        .as_mut()
        .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)?;
    let (hello, accepted_selection) = match (direction, body) {
        (
            ManagementDirection::HostToSupervisor,
            wire::management_payload::Body::HostSupervisorHello(hello),
        ) => {
            let validation = validate_host_hello(hello, connection, expected_management_token);
            hello.management_session_token.as_mut_slice().zeroize();
            let selected = validation?;
            if selected.protocol != header.protocol {
                return Err(ManagementChannelError::ProtocolMismatch);
            }
            (
                ManagementBootstrapHello::HostSupervisorAccepted,
                Some(selected),
            )
        }
        (
            ManagementDirection::SupervisorToHost,
            wire::management_payload::Body::SupervisorHello(hello),
        ) => {
            let selected = selection.ok_or(ManagementChannelError::WrongBootstrapOrder)?;
            let validation = validate_supervisor_hello(hello, selected, expected_launch_nonce);
            hello.launch_nonce.as_mut_slice().zeroize();
            validation?;
            (ManagementBootstrapHello::SupervisorAccepted, None)
        }
        _ => return Err(ManagementChannelError::WrongBootstrapPayload),
    };
    Ok(ReceivedBootstrap {
        message_id: header.message_id,
        hello,
        selection: accepted_selection,
    })
}
