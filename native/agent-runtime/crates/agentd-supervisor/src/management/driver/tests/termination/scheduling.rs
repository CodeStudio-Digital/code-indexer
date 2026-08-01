use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::ManagementChannelError;

use super::support::{
    FENCE_DUE, GRACE, LEASE_DEADLINE, NOW, cancel, fence, launch, launch_identity, launched_from,
    launched_pair_with_cancel, launched_with, launched_with_termination_failure, lifecycle_frame,
    reap,
};
use crate::management::driver::provision::pulse::{
    ProtectedRunnerPulseMonitor, RunnerPulseMonitorState, RunnerPulseObservation,
};
use crate::management::driver::tests::support::{TestWriter, decoded_bodies, launch_attempt};
use crate::management::driver::{SupervisorDriverError, SupervisorDriverStep};
use crate::process_table::PhysicalState;

#[test]
fn cancel_arms_absolute_grace_and_never_terminates_early() {
    let command = cancel(launch_identity());
    let writer = TestWriter::default();
    let (mut driver, state, _) = launched_with(
        vec![lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(command),
            "cancel",
            3,
        )],
        writer.clone(),
    );
    launch(&mut driver);

    assert_eq!(
        driver.process_next_at(NOW).expect("cancel accepted"),
        SupervisorDriverStep::CancelScheduled {
            reused_existing: false
        }
    );
    assert!(matches!(
        decoded_bodies(&writer).last(),
        Some(wire::management_payload::Body::ManagementAck(ack))
            if ack.acknowledged_message_id == "cancel"
    ));
    let early = driver
        .drive_cleanup_at(GRACE - 1, Duration::ZERO)
        .expect("before grace");
    assert_eq!(early.termination_attempts, 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);

    let due = driver
        .drive_cleanup_at(GRACE, Duration::ZERO)
        .expect("at grace");
    assert_eq!(due.termination_attempts, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn launch_installs_an_idle_lease_watchdog_without_closing_admission() {
    let (mut driver, state, _) = launched_with(Vec::new(), TestWriter::default());
    launch(&mut driver);

    assert!(driver.state().is_accepting_launches());
    assert_eq!(driver.state().pending_cleanup_count(), 1);
    let early = driver
        .drive_cleanup_at(LEASE_DEADLINE - 1, Duration::ZERO)
        .expect("before lease");
    assert_eq!(early.termination_attempts, 0);

    let due = driver
        .drive_cleanup_at(LEASE_DEADLINE, Duration::ZERO)
        .expect("at lease");
    assert_eq!(due.termination_attempts, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn failed_runner_pulse_schedules_immediate_target_cleanup() {
    let (mut driver, state, _) = launched_with(Vec::new(), TestWriter::default());
    launch(&mut driver);
    let key = driver
        .launch_registry
        .ownership_key_for_test("launch:test")
        .expect("owned launch")
        .clone();
    let (monitor, updates) = ProtectedRunnerPulseMonitor::new_for_test(
        Duration::from_millis(100),
        NOW + 1_000,
        RunnerPulseObservation::new_for_test(1, Instant::now()),
    );
    driver
        .core
        .pulse_registry
        .insert(key, monitor, NOW)
        .expect("pulse monitor");
    updates
        .send(RunnerPulseMonitorState::Failed)
        .expect("monitor retained");

    let report = driver
        .drive_cleanup_at(NOW, Duration::ZERO)
        .expect("pulse expiry cleanup");
    assert_eq!(report.termination_attempts, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn disconnect_grace_never_extends_the_existing_lease_watchdog() {
    let mut request = launch_attempt();
    request.hard_deadline_at_unix_ms = NOW + 50;
    request.authority_lease_expires_at_unix_ms = NOW + 40;
    let (mut driver, state, _) = launched_from(request, Vec::new(), TestWriter::default(), 1);
    launch(&mut driver);

    assert!(matches!(
        driver.process_next_at(NOW),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::UnexpectedEof
        ))
    ));

    let early = driver
        .drive_cleanup_at(NOW + 39, Duration::ZERO)
        .expect("before lease");
    assert_eq!(early.termination_attempts, 0);

    let due = driver
        .drive_cleanup_at(NOW + 40, Duration::ZERO)
        .expect("lease remains the earlier deadline");
    assert_eq!(due.termination_attempts, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn fence_never_extends_an_existing_cancel() {
    let identity = launch_identity();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(identity.clone())),
            "cancel",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::FenceAttemptProcess(fence(identity)),
            "fence",
            4,
        ),
    ];
    let (mut driver, state, _) = launched_with(frames, TestWriter::default());
    launch(&mut driver);
    driver.process_next_at(NOW).expect("cancel");
    assert_eq!(
        driver.process_next_at(NOW).expect("fence"),
        SupervisorDriverStep::FenceScheduled {
            reused_existing: false
        }
    );
    const {
        assert!(FENCE_DUE > GRACE);
    }

    driver
        .drive_cleanup_at(GRACE, Duration::ZERO)
        .expect("earlier cancel deadline remains");
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn reap_escalates_a_graceful_cancel_to_immediate_termination() {
    let identity = launch_identity();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(identity.clone())),
            "cancel",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(reap(identity)),
            "reap",
            4,
        ),
    ];
    let (mut driver, state, _) = launched_with(frames, TestWriter::default());
    launch(&mut driver);
    driver.process_next_at(NOW).expect("cancel");
    assert_eq!(
        driver.process_next_at(NOW).expect("reap"),
        SupervisorDriverStep::ReapScheduled {
            reused_existing: false
        }
    );

    driver
        .drive_cleanup_at(NOW, Duration::ZERO)
        .expect("reap starts immediately");
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn reap_interrupts_a_pending_termination_retry_immediately() {
    let identity = launch_identity();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(identity.clone())),
            "cancel",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(reap(identity)),
            "reap",
            4,
        ),
    ];
    let (mut driver, state, _) = launched_with_termination_failure(frames);
    launch(&mut driver);
    driver.process_next_at(NOW).expect("cancel");

    let failed = driver
        .drive_cleanup_at(GRACE, Duration::ZERO)
        .expect("termination failure is retained for retry");
    assert_eq!(failed.termination_attempts, 1);
    assert_eq!(failed.termination_failures, 1);

    driver
        .process_next_at(GRACE + 1)
        .expect("reap interrupts retry delay");
    let immediate_retry = driver
        .drive_cleanup_at(GRACE + 1, Duration::ZERO)
        .expect("reap makes the retry immediately due");
    assert_eq!(immediate_retry.termination_attempts, 1);
    assert_eq!(immediate_retry.termination_failures, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn reap_interrupts_a_pending_physical_reap_retry_immediately() {
    let identity = launch_identity();
    let frames = vec![
        lifecycle_frame(
            wire::management_payload::Body::CancelAttemptProcess(cancel(identity.clone())),
            "cancel",
            3,
        ),
        lifecycle_frame(
            wire::management_payload::Body::ReapAttemptProcess(reap(identity)),
            "reap",
            4,
        ),
    ];
    let (mut driver, state, _) = launched_with(frames, TestWriter::default());
    launch(&mut driver);
    driver.process_next_at(NOW).expect("cancel");
    driver
        .drive_cleanup_at(GRACE, Duration::ZERO)
        .expect("first reap failure is retained");
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);

    driver
        .process_next_at(GRACE + 1)
        .expect("reap command accepted");
    let immediate_retry = driver
        .drive_cleanup_at(GRACE + 1, Duration::ZERO)
        .expect("reap command makes physical retry immediately due");
    assert_eq!(immediate_retry.reap_attempts, 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn cancelling_one_attempt_never_changes_its_parallel_sibling() {
    let (mut driver, state) = launched_pair_with_cancel();
    driver.process_next_at(1_000).expect("first launch");
    driver.process_next_at(1_001).expect("second launch");
    driver.process_next_at(NOW).expect("first cancel");

    driver
        .drive_cleanup_at(GRACE, Duration::ZERO)
        .expect("target cleanup");

    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.owned_attempts(), 2);
    assert_eq!(driver.state().pending_cleanup_count(), 2);
    assert_eq!(
        driver.physical_state_for_test("launch:second"),
        Some(PhysicalState::Reserved)
    );
    assert_eq!(
        driver.physical_state_for_test("launch:test"),
        Some(PhysicalState::Reaping)
    );
}
