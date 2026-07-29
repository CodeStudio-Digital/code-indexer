use agent_protocol::generated::v1 as wire;

pub(super) fn control_ack(
    message_id: String,
    payload_sha256: [u8; 32],
    acknowledged_at_unix_ms: i64,
) -> wire::FramePayload {
    wire::FramePayload {
        body: Some(wire::frame_payload::Body::Ack(wire::Ack {
            acknowledged_message_id: message_id,
            acknowledged_payload_sha256: payload_sha256.to_vec(),
            acknowledged_at_unix_ms,
        })),
    }
}
