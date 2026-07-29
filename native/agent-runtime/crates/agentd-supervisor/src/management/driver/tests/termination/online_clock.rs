use std::sync::atomic::Ordering;

use super::support::{NOW, launched_pair_with_reap};
use crate::management::driver::tests::fakes::ManualLifecycleClock;
use crate::management::{CleanupStateError, SupervisorLifecycleOwner};
use crate::process_table::PhysicalState;

const REAP_CEILING: i64 = NOW + 500;

#[test]
fn termination_crossing_reap_ceiling_retains_target_and_sibling() {
    let (mut driver, state) = launched_pair_with_reap();
    driver.process_next_at(1_000).expect("first launch");
    driver.process_next_at(1_001).expect("second launch");
    driver.process_next_at(NOW).expect("reap armed");
    let clock = ManualLifecycleClock::new(NOW);
    state.advance_clock_on_next_termination(clock.clone(), REAP_CEILING);

    assert_eq!(
        SupervisorLifecycleOwner::drive_cleanup_tick(&mut driver, &clock),
        Err(CleanupStateError::CleanupDeadlineElapsed)
    );

    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 2);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.physical_state_for_test("launch:test"),
        Some(PhysicalState::Cancelling)
    );
    assert_eq!(
        driver.physical_state_for_test("launch:second"),
        Some(PhysicalState::Reserved)
    );
}

#[test]
fn reap_crossing_ceiling_never_commits_release_or_changes_sibling() {
    let (mut driver, state) = launched_pair_with_reap();
    driver.process_next_at(1_000).expect("first launch");
    driver.process_next_at(1_001).expect("second launch");
    driver.process_next_at(NOW).expect("reap armed");
    let clock = ManualLifecycleClock::new(NOW);
    state.advance_clock_on_next_reap(clock.clone(), REAP_CEILING);

    assert_eq!(
        SupervisorLifecycleOwner::drive_cleanup_tick(&mut driver, &clock),
        Err(CleanupStateError::CleanupDeadlineElapsed)
    );

    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.reap_calls.load(Ordering::SeqCst), 1);
    assert_eq!(driver.owned_attempts(), 2);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.physical_state_for_test("launch:test"),
        Some(PhysicalState::Reaping)
    );
    assert_eq!(
        driver.physical_state_for_test("launch:second"),
        Some(PhysicalState::Reserved)
    );
}
