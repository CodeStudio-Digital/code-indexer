use std::sync::atomic::Ordering;
use std::time::Duration;

use agent_protocol::management_channel::ManagementChannelError;

use super::super::{
    AdmissionClosureReason, SupervisorDriverError, SupervisorDriverStep, SupervisorPhysicalDriver,
};
use super::fakes::{FakeContainment, FakeProvisioner, ManualLifecycleClock};
use super::support::{
    TestWriter, established, launch_attempt, launch_frame, peer_authority, trusted_runner,
};
use crate::management::driver::plan::LaunchPlan;
use crate::process_table::PendingSpawnReservation;

#[test]
fn eof_closes_admission_then_obeys_grace_before_termination_and_reap() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    assert!(matches!(
        driver.process_next_at(1_000),
        Ok(SupervisorDriverStep::LaunchAccepted { .. })
    ));

    assert!(matches!(
        driver.process_next_at(2_000),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::UnexpectedEof
        ))
    ));
    assert_eq!(
        driver.state().closure_reason(),
        Some(AdmissionClosureReason::UnexpectedEof)
    );
    assert_eq!(driver.state().pending_cleanup_count(), 1);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );

    let before = driver
        .drive_cleanup_at(2_999, Duration::ZERO)
        .expect("before grace");
    assert_eq!(before.termination_attempts, 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);

    let due = driver
        .drive_cleanup_at(3_000, Duration::ZERO)
        .expect("at grace");
    assert_eq!(due.termination_attempts, 1);
    assert_eq!(due.reap_attempts, 1);
    assert_eq!(due.reaped, 0);
    assert_eq!(due.retained_for_reap, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );
}

#[test]
fn failed_termination_is_retried_before_any_reap() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::failing_termination();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver.process_next_at(1_000).expect("launch");
    assert!(matches!(
        driver.process_next_at(2_000),
        Err(SupervisorDriverError::Channel(
            ManagementChannelError::UnexpectedEof
        ))
    ));

    let first = driver
        .drive_cleanup_at(3_000, Duration::ZERO)
        .expect("first termination");
    assert_eq!(first.termination_attempts, 1);
    assert_eq!(first.termination_failures, 1);
    assert_eq!(first.reap_attempts, 0);

    let early = driver
        .drive_cleanup_at(3_099, Duration::ZERO)
        .expect("before retry");
    assert_eq!(early.termination_attempts, 0);
    assert_eq!(early.reap_attempts, 0);

    let retry = driver
        .drive_cleanup_at(3_100, Duration::ZERO)
        .expect("termination retry");
    assert_eq!(retry.termination_attempts, 1);
    assert_eq!(retry.termination_failures, 1);
    assert_eq!(retry.reap_attempts, 0);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 2);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
    assert!(driver.reserved_memory_bytes() > 0);
}

#[test]
fn cleanup_waits_for_a_launching_attempt_instead_of_advancing_to_reap() {
    let channel = established(Vec::new(), TestWriter::default());
    let (containment, state) = FakeContainment::healthy();
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    let mut core = driver.core;
    let plan = LaunchPlan::from_validated(&launch_attempt(), [4; 32]).expect("launch plan");
    let key = plan.ownership_key();
    let _pending = match core
        .ownership
        .reserve_pending_spawn(plan.metadata(), plan.budget())
        .expect("reserve launching attempt")
    {
        PendingSpawnReservation::Reserved(pending) => *pending,
        PendingSpawnReservation::AlreadyOwned(owned) => {
            panic!("unexpected existing ownership: {owned:?}")
        }
    };
    core.state
        .schedule_attempt_cleanup(1_000, 0, true, [key])
        .expect("schedule cleanup");

    let report = core
        .drive_cleanup_with_clock(
            &ManualLifecycleClock::new(1_000),
            Duration::ZERO,
            usize::MAX,
        )
        .expect("launching cleanup is retained");

    assert_eq!(report.termination_attempts, 1);
    assert_eq!(report.reap_attempts, 0);
    assert_eq!(report.retained_for_reap, 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn ownership_reap_error_restores_a_future_retry_before_hard_restart() {
    let channel = established(Vec::new(), TestWriter::default());
    let (containment, _) = FakeContainment::healthy();
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FakeProvisioner::successful(),
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    let mut core = driver.core;
    let plan = LaunchPlan::from_validated(&launch_attempt(), [5; 32]).expect("launch plan");
    let key = plan.ownership_key();
    core.state
        .schedule_attempt_cleanup(1_000, 0, true, [key.clone()])
        .expect("schedule cleanup");
    assert_eq!(
        core.state
            .take_due_terminations(1_000, 1)
            .expect("termination"),
        vec![key.clone()]
    );
    core.state
        .schedule_reap(&key, 1_000)
        .expect("schedule reap");

    assert_eq!(
        core.drive_cleanup_with_clock(
            &ManualLifecycleClock::new(1_000),
            Duration::ZERO,
            usize::MAX,
        ),
        Err(super::super::state::CleanupStateError::InvalidTransition)
    );
    assert!(
        core.state
            .take_due_reaps(1_099, 1)
            .expect("before retry")
            .is_empty()
    );
    assert_eq!(
        core.state.take_due_reaps(1_100, 1).expect("retry due"),
        vec![key]
    );
}
