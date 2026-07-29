use std::io::Cursor;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use super::super::{
    AdmissionClosureReason, CleanupStateError, SupervisorDriverError, SupervisorPhysicalDriver,
};
use super::fakes::{
    ContainmentState, FakeContainment, FakeError, FakeProvisioner, ManualLifecycleClock,
};
use super::support::{
    TestWriter, established, launch_attempt, launch_frame, peer_authority, trusted_runner,
};
use crate::process_table::PhysicalState;

const RECEIVED_AT: i64 = 1_000;
const BEFORE_EFFECT: i64 = 1_010;

type TestDriver =
    SupervisorPhysicalDriver<Cursor<Vec<u8>>, TestWriter, FakeContainment, FakeProvisioner>;

#[test]
fn regressed_clock_after_spawn_schedules_and_retains_the_physical_owner() {
    assert_spawn_clock_failure(BEFORE_EFFECT - 1, CleanupStateError::ClockRegressed);
}

#[test]
fn invalid_clock_after_spawn_schedules_and_retains_the_physical_owner() {
    assert_spawn_clock_failure(0, CleanupStateError::InvalidTime);
}

#[test]
fn regressed_clock_after_failed_completion_retains_cleanup_and_owner() {
    assert_completion_clock_failure(BEFORE_EFFECT - 1, CleanupStateError::ClockRegressed);
}

#[test]
fn invalid_clock_after_failed_completion_retains_cleanup_and_owner() {
    assert_completion_clock_failure(0, CleanupStateError::InvalidTime);
}

#[test]
fn regressed_launch_receipt_fails_before_an_early_rejection_or_physical_effect() {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch:regressed", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let provision_calls = Arc::clone(&provisioner.calls);
    let complete_calls = Arc::clone(&provisioner.complete_calls);
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    driver
        .core
        .state
        .close_and_schedule(
            AdmissionClosureReason::Shutdown,
            BEFORE_EFFECT,
            0,
            true,
            std::iter::empty(),
        )
        .expect("closed admission");
    driver.last_observed_at_unix_ms = Some(BEFORE_EFFECT);

    assert_clock_failure(
        process_launch(&mut driver, &ManualLifecycleClock::new(BEFORE_EFFECT)),
        CleanupStateError::ClockRegressed,
    );
    assert_eq!(provision_calls.load(Ordering::SeqCst), 0);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 0);
}

fn assert_spawn_clock_failure(failed_at_unix_ms: i64, expected: CleanupStateError) {
    let clock = ManualLifecycleClock::new(BEFORE_EFFECT);
    let provisioner = FakeProvisioner::successful();
    let complete_calls = Arc::clone(&provisioner.complete_calls);
    let (mut driver, state) = test_driver(provisioner);
    state.advance_clock_on_next_spawn(clock.clone(), failed_at_unix_ms);

    assert_clock_failure(process_launch(&mut driver, &clock), expected);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert_retained_owner(&driver, &state);
}

fn assert_completion_clock_failure(failed_at_unix_ms: i64, expected: CleanupStateError) {
    let clock = ManualLifecycleClock::new(BEFORE_EFFECT);
    let provisioner = FakeProvisioner::failing_completion();
    let cleanup = provisioner.cleanup_state();
    let complete_calls = Arc::clone(&provisioner.complete_calls);
    provisioner.advance_clock_on_next_completion(clock.clone(), failed_at_unix_ms);
    let (mut driver, state) = test_driver(provisioner);

    assert_clock_failure(process_launch(&mut driver, &clock), expected);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.retained_completion_cleanups(), 1);
    assert_eq!(cleanup.attempts.load(Ordering::SeqCst), 0);
    assert_eq!(cleanup.drops.load(Ordering::SeqCst), 0);
    assert_retained_owner(&driver, &state);
}

fn test_driver(provisioner: FakeProvisioner) -> (TestDriver, Arc<ContainmentState>) {
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch:clock-failure", 2)],
        TestWriter::default(),
    );
    let (containment, state) = FakeContainment::healthy();
    let driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");
    (driver, state)
}

fn process_launch(
    driver: &mut TestDriver,
    clock: &ManualLifecycleClock,
) -> Result<(), SupervisorDriverError<FakeError>> {
    let received = driver.channel.begin_receive();
    driver
        .process_received(received, RECEIVED_AT, RECEIVED_AT, clock)
        .map(drop)
}

fn assert_clock_failure(
    result: Result<(), SupervisorDriverError<FakeError>>,
    expected: CleanupStateError,
) {
    match result {
        Err(SupervisorDriverError::CleanupState(actual)) => assert_eq!(actual, expected),
        other => panic!("unexpected clock result: {other:?}"),
    }
}

fn assert_retained_owner(driver: &TestDriver, state: &ContainmentState) {
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.group_drops.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
    assert!(driver.state().pending_cleanup_count() > 0);
    assert!(!driver.state().is_accepting_launches());
    assert!(driver.is_channel_poisoned());
    assert_eq!(
        driver.physical_state_for_test("launch:test"),
        Some(PhysicalState::Cancelling)
    );
}
