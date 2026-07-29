use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::generated::v1 as wire;

use super::support::{
    NOW, cancel, launch, launch_identity, launched_from, launched_with, lifecycle_frame, reap,
};
use crate::management::driver::tests::support::{TestWriter, launch_attempt};
use crate::management::driver::{CleanupStateError, SupervisorDriverError};

#[test]
fn cancel_beyond_the_sealed_grace_never_targets_the_adapter() {
    let mut command = cancel(launch_identity());
    command.grace_deadline_at_unix_ms = NOW + 101;
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(command),
            "cancel",
            3,
        )],
        TestWriter::default(),
    );
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::InvalidTerminationPlan)
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert!(driver.is_channel_poisoned());
    assert_eq!(driver.owned_attempts(), 1);
}

#[test]
fn fresh_expired_cancel_reaches_the_planner_and_fails_closed() {
    let mut command = cancel(launch_identity());
    command.grace_deadline_at_unix_ms = 1;
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(command),
            "cancel:expired",
            3,
        )],
        TestWriter::default(),
    );
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::InvalidTerminationPlan)
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert!(driver.is_channel_poisoned());
}

#[test]
fn fresh_expired_reap_reaches_the_planner_and_fails_closed() {
    let mut command = reap(launch_identity());
    command.reap_deadline_at_unix_ms = 1;
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(command),
            "reap:expired",
            3,
        )],
        TestWriter::default(),
    );
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::InvalidTerminationPlan)
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert!(driver.is_channel_poisoned());
}

#[test]
fn cancel_grace_cannot_cross_the_immutable_hard_deadline() {
    let mut launch_request = launch_attempt();
    launch_request.hard_deadline_at_unix_ms = NOW + 50;
    launch_request.authority_lease_expires_at_unix_ms = NOW + 40;
    let identity = launch_request.identity.clone().expect("identity");
    let (mut driver, state, _) = launched_from(
        launch_request,
        vec![lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(identity)),
            "cancel",
            3,
        )],
        TestWriter::default(),
        1,
    );
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::InvalidTerminationPlan)
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 1);
}

#[test]
fn stale_identity_never_selects_or_immediately_terminates_the_current_attempt() {
    let mut identity = launch_identity();
    identity.fencing_epoch += 1;
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(identity)),
            "cancel:stale",
            3,
        )],
        TestWriter::default(),
    );
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::UnknownTerminationTarget)
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
}

#[test]
fn stale_runtime_never_reaps_or_immediately_terminates_the_current_attempt() {
    let mut command = reap(launch_identity());
    command.runtime_instance_id = "runtime:stale".into();
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(command),
            "reap:stale",
            3,
        )],
        TestWriter::default(),
    );
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::InvalidTerminationPlan)
    ));
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 1);
}

#[test]
fn acknowledgement_write_failure_keeps_schedule_ownership_and_reservation() {
    let writer = TestWriter::default();
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(launch_identity())),
            "cancel",
            3,
        )],
        writer.clone(),
    );
    launch(&mut driver);
    writer.fail_on_next_write();

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::Channel(_))
    ));
    assert!(!driver.state().is_accepting_launches());
    assert_eq!(driver.state().pending_cleanup_count(), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
}

#[test]
fn reap_ceiling_failure_preserves_the_exact_owner_for_hard_restart() {
    let identity = launch_identity();
    let reap_deadline = NOW + 500;
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(reap(identity)),
            "reap",
            3,
        )],
        TestWriter::default(),
    );
    launch(&mut driver);
    driver.process_next_at(NOW).expect("reap armed");

    assert_eq!(
        driver.drive_cleanup_at(reap_deadline, Duration::ZERO),
        Err(CleanupStateError::CleanupDeadlineElapsed)
    );
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
}
