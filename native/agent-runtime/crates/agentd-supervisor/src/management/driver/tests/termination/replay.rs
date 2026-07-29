use std::sync::atomic::Ordering;

use agent_protocol::generated::v1 as wire;

use super::support::{
    NOW, cancel, fence, launch, launch_identity, launched_pair_reusing_a_termination_key,
    launched_with, lifecycle_frame,
};
use crate::management::driver::tests::support::{TestWriter, decoded_bodies, decoded_frames};
use crate::management::driver::{SupervisorDriverError, SupervisorDriverStep};

#[test]
fn exact_transport_replay_reuses_the_physical_ack_without_another_intent() {
    let encoded = lifecycle_frame(
        wire::management_payload::Body::CancelAttemptProcess(cancel(launch_identity())),
        "cancel",
        3,
    );
    let writer = TestWriter::default();
    let (mut driver, state, _) = launched_with(vec![encoded.clone(), encoded], writer.clone());
    launch(&mut driver);

    driver.process_next_at(NOW).expect("fresh cancel");
    assert_eq!(
        driver.process_next_at(NOW).expect("physical replay"),
        SupervisorDriverStep::Replay
    );
    assert_eq!(driver.state().pending_cleanup_count(), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    let frames = decoded_frames(&writer);
    assert_eq!(frames.len(), 4);
    assert_eq!(frames[2], frames[3]);
}

#[test]
fn semantic_retry_gets_a_new_correlated_ack_without_rescheduling() {
    let command = cancel(launch_identity());
    let writer = TestWriter::default();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(command.clone()),
            "cancel:first",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(command),
            "cancel:retry",
            4,
        ),
    ];
    let (mut driver, state, _) = launched_with(frames, writer.clone());
    launch(&mut driver);
    driver.process_next_at(NOW).expect("fresh cancel");

    assert_eq!(
        driver.process_next_at(NOW + 1).expect("semantic retry"),
        SupervisorDriverStep::CancelScheduled {
            reused_existing: true
        }
    );
    assert_eq!(driver.state().pending_cleanup_count(), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    let acknowledgements = decoded_bodies(&writer)
        .into_iter()
        .filter_map(|body| match body {
            wire::management_payload::Body::ManagementAck(ack) => Some(ack),
            _ => None,
        })
        .collect::<Vec<_>>();
    assert_eq!(acknowledgements.len(), 2);
    assert_eq!(acknowledgements[0].acknowledged_message_id, "cancel:first");
    assert_eq!(acknowledgements[1].acknowledged_message_id, "cancel:retry");
}

#[test]
fn conflicting_semantic_retry_poison_closes_and_arms_physical_cleanup() {
    let first = cancel(launch_identity());
    let mut conflicting = first.clone();
    conflicting.reason_code = "different.reason".into();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(first),
            "cancel:first",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(conflicting),
            "cancel:conflict",
            4,
        ),
    ];
    let (mut driver, state, _) = launched_with(frames, TestWriter::default());
    launch(&mut driver);
    driver.process_next_at(NOW).expect("fresh cancel");

    assert!(matches!(
        driver.process_next_at(NOW + 1),
        Err(SupervisorDriverError::TerminationConflict)
    ));
    assert!(driver.is_channel_poisoned());
    assert!(!driver.state().is_accepting_launches());
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
}

#[test]
fn one_idempotency_key_cannot_alias_cancel_and_fence() {
    let identity = launch_identity();
    let cancel_command = cancel(identity.clone());
    let mut fence_command = fence(identity);
    fence_command.idempotency_key = cancel_command.idempotency_key.clone();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel_command),
            "cancel",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::FenceAttemptProcess(fence_command),
            "fence",
            4,
        ),
    ];
    let (mut driver, _, _) = launched_with(frames, TestWriter::default());
    launch(&mut driver);
    driver.process_next_at(NOW).expect("cancel");

    assert!(matches!(
        driver.process_next_at(NOW + 1),
        Err(SupervisorDriverError::TerminationConflict)
    ));
    assert!(driver.is_channel_poisoned());
}

#[test]
fn one_idempotency_key_cannot_alias_two_attempts() {
    let mut driver = launched_pair_reusing_a_termination_key();
    driver.process_next_at(1_000).expect("first launch");
    driver.process_next_at(1_001).expect("second launch");
    driver.process_next_at(NOW).expect("first cancel");

    assert!(matches!(
        driver.process_next_at(NOW + 1),
        Err(SupervisorDriverError::TerminationConflict)
    ));
    assert!(driver.is_channel_poisoned());
}
