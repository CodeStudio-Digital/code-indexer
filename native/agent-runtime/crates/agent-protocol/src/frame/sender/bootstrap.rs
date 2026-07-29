use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId};
use crate::version::ProtocolVersion;

use super::{HeaderCoordinates, OutboundFrameError, frame_header};
use crate::frame::{FrameDirection, encode_attempt_frame, scrub_body_secrets};

struct ScrubbedBootstrapPayload(wire::FramePayload);

impl Drop for ScrubbedBootstrapPayload {
    fn drop(&mut self) {
        if let Some(body) = self.0.body.as_mut() {
            scrub_body_secrets(body);
        }
    }
}

pub(in crate::frame) fn encode_bootstrap_hello<F>(
    protocol: ProtocolVersion,
    connection: &ConnectionId,
    identity: &AttemptIdentity,
    direction: FrameDirection,
    body: wire::frame_payload::Body,
    maximum_frame_bytes: usize,
    clock: F,
) -> Result<Vec<u8>, OutboundFrameError>
where
    F: FnOnce() -> i64,
{
    let payload = ScrubbedBootstrapPayload(wire::FramePayload { body: Some(body) });
    let body = payload.0.body.as_ref().expect("body was installed");
    let valid = matches!(
        (direction, body),
        (
            FrameDirection::RunnerToHost,
            wire::frame_payload::Body::AgentHello(_)
        ) | (
            FrameDirection::HostToRunner,
            wire::frame_payload::Body::HostHello(_)
        )
    );
    if !valid {
        return Err(OutboundFrameError::WrongBootstrapDirection);
    }
    let label = match direction {
        FrameDirection::RunnerToHost => "agent",
        FrameDirection::HostToRunner => "host",
    };
    let header = frame_header(
        protocol,
        connection,
        identity,
        HeaderCoordinates {
            stream_seq: 1,
            message_id: format!("bootstrap:{label}:1"),
            reply_to_message_id: None,
            sent_at_unix_ms: clock(),
            deadline_at_unix_ms: None,
        },
    );
    encode_attempt_frame(
        header,
        wire::TransportChannel::Control,
        &payload.0,
        maximum_frame_bytes,
    )
    .map_err(OutboundFrameError::Frame)
}
