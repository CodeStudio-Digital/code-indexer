use agent_protocol::generated::v1 as wire;

use super::support::{
    active_driver, assert_revoked, decoded_ack, decoded_output, frame_payload_digest,
};
use crate::control::tests::support::{
    CANCEL_GRACE_DEADLINE, FENCED_AT, ManualClock, cancel_frame, fence_frame,
};
use crate::control::{CancelOutcome, ControlDriverEvent, FenceOutcome};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn cancel_revokes_then_commits_ack_and_cancelling_state() {
    let request = cancel_frame("cancel-1", 4);
    let expected_digest = frame_payload_digest(&request);
    let clock = ManualClock::new(1_000);
    let (mut driver, control, gate) = Box::pin(active_driver([request], clock)).await;
    let token = gate.token().expect("active token");

    let ControlDriverEvent::Cancel(CancelOutcome::Accepted(cancelled)) =
        Box::pin(driver.receive_next())
            .await
            .expect("CancelAttempt")
    else {
        panic!("expected accepted cancellation");
    };

    assert_eq!(cancelled.reason(), wire::CancelReason::UserRequest);
    assert_eq!(cancelled.reason_code(), "user_request");
    assert_eq!(cancelled.grace_deadline_at_unix_ms(), CANCEL_GRACE_DEADLINE);
    assert_eq!(driver.state(), RunnerState::Cancelling);
    assert_revoked(&gate, &token);

    let frames = decoded_output(&control);
    assert_eq!(frames.len(), 4);
    let header = frames[3].header.as_ref().expect("Cancel Ack header");
    assert_eq!(header.reply_to_message_id.as_deref(), Some("cancel-1"));
    let ack = decoded_ack(&frames[3]);
    assert_eq!(ack.acknowledged_message_id, "cancel-1");
    assert_eq!(ack.acknowledged_payload_sha256, expected_digest);
    assert_eq!(ack.acknowledged_at_unix_ms, 1_200);
}

#[tokio::test]
async fn fence_revokes_then_commits_ack_and_cancelling_state() {
    let request = fence_frame("fence-1", 4);
    let expected_digest = frame_payload_digest(&request);
    let clock = ManualClock::new(1_000);
    let (mut driver, control, gate) = Box::pin(active_driver([request], clock)).await;
    let token = gate.token().expect("active token");

    let ControlDriverEvent::Fence(FenceOutcome::Accepted(fenced)) =
        Box::pin(driver.receive_next()).await.expect("FenceAttempt")
    else {
        panic!("expected accepted fence");
    };

    assert_eq!(fenced.replacement_fencing_epoch(), 8);
    assert_eq!(fenced.reason_code(), "superseded");
    assert_eq!(fenced.fenced_at_unix_ms(), FENCED_AT);
    assert_eq!(driver.state(), RunnerState::Cancelling);
    assert_revoked(&gate, &token);

    let frames = decoded_output(&control);
    assert_eq!(frames.len(), 4);
    let header = frames[3].header.as_ref().expect("Fence Ack header");
    assert_eq!(header.reply_to_message_id.as_deref(), Some("fence-1"));
    let ack = decoded_ack(&frames[3]);
    assert_eq!(ack.acknowledged_message_id, "fence-1");
    assert_eq!(ack.acknowledged_payload_sha256, expected_digest);
    assert_eq!(ack.acknowledged_at_unix_ms, 1_200);
}
