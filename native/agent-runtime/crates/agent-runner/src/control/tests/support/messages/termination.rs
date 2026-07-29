use agent_protocol::generated::v1 as wire;

use super::{SPEC_DEADLINE, encoded_control, wire_identity};

pub(in crate::control::tests) const CANCEL_GRACE_DEADLINE: i64 = 1_300;
pub(in crate::control::tests) const FENCED_AT: i64 = 1_200;

pub(in crate::control::tests) fn cancel_frame(message_id: &str, stream_seq: u64) -> Vec<u8> {
    cancel_frame_with(message_id, stream_seq, |_| {})
}

pub(in crate::control::tests) fn cancel_frame_with(
    message_id: &str,
    stream_seq: u64,
    update: impl FnOnce(&mut wire::CancelAttempt),
) -> Vec<u8> {
    let mut request = wire::CancelAttempt {
        identity: Some(wire_identity()),
        reason: wire::CancelReason::UserRequest as i32,
        reason_code: "user_request".to_owned(),
        grace_deadline_at_unix_ms: CANCEL_GRACE_DEADLINE,
        idempotency_key: "cancel-key".to_owned(),
    };
    update(&mut request);
    encoded_control(
        wire::frame_payload::Body::CancelAttempt(request),
        message_id,
        stream_seq,
        CANCEL_GRACE_DEADLINE,
    )
}

pub(in crate::control::tests) fn fence_frame(message_id: &str, stream_seq: u64) -> Vec<u8> {
    fence_frame_with(message_id, stream_seq, |_| {})
}

pub(in crate::control::tests) fn fence_frame_with(
    message_id: &str,
    stream_seq: u64,
    update: impl FnOnce(&mut wire::FenceAttempt),
) -> Vec<u8> {
    let mut request = wire::FenceAttempt {
        identity: Some(wire_identity()),
        replacement_fencing_epoch: 8,
        reason_code: "superseded".to_owned(),
        fenced_at_unix_ms: FENCED_AT,
        idempotency_key: "fence-key".to_owned(),
    };
    update(&mut request);
    encoded_control(
        wire::frame_payload::Body::FenceAttempt(request),
        message_id,
        stream_seq,
        SPEC_DEADLINE,
    )
}
