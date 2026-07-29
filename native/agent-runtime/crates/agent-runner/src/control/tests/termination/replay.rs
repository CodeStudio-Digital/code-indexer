use super::support::{active_driver, decoded_ack, decoded_output, frame_payload_digest};
use crate::control::tests::support::{
    ManualClock, cancel_frame, cancel_frame_with, decode_written_raw_frames, fence_frame,
};
use crate::control::{
    AsyncControlDriverError, CancelOutcome, ControlDriverEvent, ControlError, FenceOutcome,
};
use crate::lifecycle::RunnerState;

#[tokio::test]
async fn exact_cancel_replay_resends_identical_ack_bytes() {
    let request = cancel_frame("cancel-replay", 4);
    let clock = ManualClock::new(1_000);
    let (mut driver, control, _) = Box::pin(active_driver([request.clone(), request], clock)).await;

    assert!(matches!(
        Box::pin(driver.receive_next())
            .await
            .expect("CancelAttempt"),
        ControlDriverEvent::Cancel(CancelOutcome::Accepted(_))
    ));
    let ControlDriverEvent::Replayed(replay) = Box::pin(driver.receive_next())
        .await
        .expect("Cancel replay")
    else {
        panic!("expected exact transport replay");
    };

    assert_eq!(replay.message_id(), "cancel-replay");
    assert_eq!(replay.stream_seq(), 4);
    assert_eq!(driver.state(), RunnerState::Cancelling);
    let raw = decode_written_raw_frames(&control.written()).expect("raw outbound frames");
    assert_eq!(raw.len(), 5);
    assert_eq!(raw[3], raw[4]);
}

#[tokio::test]
async fn semantic_cancel_retry_gets_a_fresh_correlated_ack() {
    let first = cancel_frame("cancel-first", 4);
    let retry = cancel_frame("cancel-retry", 5);
    let expected_digest = frame_payload_digest(&first);
    let clock = ManualClock::new(1_000);
    let (mut driver, control, _) = Box::pin(active_driver([first, retry], clock)).await;

    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("first Cancel"),
        ControlDriverEvent::Cancel(CancelOutcome::Accepted(_))
    ));
    assert!(matches!(
        Box::pin(driver.receive_next())
            .await
            .expect("semantic Cancel retry"),
        ControlDriverEvent::Cancel(CancelOutcome::AlreadyAccepted(_))
    ));

    let frames = decoded_output(&control);
    let raw = decode_written_raw_frames(&control.written()).expect("raw outbound frames");
    assert_eq!(frames.len(), 5);
    assert_eq!(raw.len(), 5);
    assert_ne!(raw[3], raw[4]);
    assert_eq!(
        frames[3]
            .header
            .as_ref()
            .expect("first Ack header")
            .reply_to_message_id
            .as_deref(),
        Some("cancel-first")
    );
    assert_eq!(
        frames[4]
            .header
            .as_ref()
            .expect("retry Ack header")
            .reply_to_message_id
            .as_deref(),
        Some("cancel-retry")
    );
    let first_ack = decoded_ack(&frames[3]);
    let retry_ack = decoded_ack(&frames[4]);
    assert_eq!(first_ack.acknowledged_message_id, "cancel-first");
    assert_eq!(retry_ack.acknowledged_message_id, "cancel-retry");
    assert_eq!(first_ack.acknowledged_payload_sha256, expected_digest);
    assert_eq!(
        first_ack.acknowledged_payload_sha256,
        retry_ack.acknowledged_payload_sha256
    );
}

#[tokio::test]
async fn fence_supports_exact_replay_and_semantic_retry() {
    let exact = fence_frame("fence-replay", 4);
    let clock = ManualClock::new(1_000);
    let (mut driver, control, _) = Box::pin(active_driver([exact.clone(), exact], clock)).await;
    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("FenceAttempt"),
        ControlDriverEvent::Fence(FenceOutcome::Accepted(_))
    ));
    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("Fence replay"),
        ControlDriverEvent::Replayed(_)
    ));
    let raw = decode_written_raw_frames(&control.written()).expect("raw Fence replay");
    assert_eq!(raw.len(), 5);
    assert_eq!(raw[3], raw[4]);

    let first = fence_frame("fence-first", 4);
    let retry = fence_frame("fence-retry", 5);
    let expected_digest = frame_payload_digest(&first);
    let clock = ManualClock::new(1_000);
    let (mut driver, control, _) = Box::pin(active_driver([first, retry], clock)).await;
    assert!(matches!(
        Box::pin(driver.receive_next()).await.expect("first Fence"),
        ControlDriverEvent::Fence(FenceOutcome::Accepted(_))
    ));
    assert!(matches!(
        Box::pin(driver.receive_next())
            .await
            .expect("semantic Fence retry"),
        ControlDriverEvent::Fence(FenceOutcome::AlreadyAccepted(_))
    ));

    let frames = decoded_output(&control);
    let raw = decode_written_raw_frames(&control.written()).expect("raw Fence retry");
    assert_eq!(frames.len(), 5);
    assert_ne!(raw[3], raw[4]);
    let first_ack = decoded_ack(&frames[3]);
    let retry_ack = decoded_ack(&frames[4]);
    assert_eq!(first_ack.acknowledged_message_id, "fence-first");
    assert_eq!(retry_ack.acknowledged_message_id, "fence-retry");
    assert_eq!(first_ack.acknowledged_payload_sha256, expected_digest);
    assert_eq!(
        first_ack.acknowledged_payload_sha256,
        retry_ack.acknowledged_payload_sha256
    );
}

#[tokio::test]
async fn termination_retry_conflicts_and_cross_kind_commands_fail_closed() {
    let cases = [
        (
            cancel_frame("cancel-first", 4),
            cancel_frame_with("cancel-changed", 5, |request| {
                request.reason_code = "changed".to_owned();
            }),
        ),
        (
            cancel_frame("cancel-first", 4),
            cancel_frame_with("cancel-key-change", 5, |request| {
                request.idempotency_key = "other-key".to_owned();
            }),
        ),
        (
            cancel_frame("cancel-first", 4),
            fence_frame("fence-after-cancel", 5),
        ),
        (
            fence_frame("fence-first", 4),
            cancel_frame("cancel-after-fence", 5),
        ),
    ];

    for (first, conflict) in cases {
        let clock = ManualClock::new(1_000);
        let (mut driver, control, _) = Box::pin(active_driver(vec![first, conflict], clock)).await;
        let first = Box::pin(driver.receive_next())
            .await
            .expect("first termination");
        assert!(matches!(
            first,
            ControlDriverEvent::Cancel(CancelOutcome::Accepted(_))
                | ControlDriverEvent::Fence(FenceOutcome::Accepted(_))
        ));

        let result = Box::pin(driver.receive_next()).await;

        assert!(matches!(
            result,
            Err(AsyncControlDriverError::Control(
                ControlError::TerminationConflict
            ))
        ));
        assert_eq!(decoded_output(&control).len(), 4);
        assert!(driver.is_closed());
        assert_eq!(driver.state(), RunnerState::Exiting);
    }
}
