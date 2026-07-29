use std::sync::atomic::Ordering;

use super::super::super::fakes::{FakeProvisioner, ManualLifecycleClock};
use super::super::fixtures::empty_core_with;
use super::raw_pair;
use crate::management::{
    CleanupStateError, SupervisorAsyncService, SupervisorAsyncServiceAdvance,
    SupervisorAsyncServiceStatus, SupervisorDriverError, TokioSupervisorLifecycleTimer,
};

#[tokio::test]
async fn post_spawn_clock_regression_closes_and_retains_the_async_owner() {
    let clock = ManualLifecycleClock::new(2_000_000_000_000);
    let clock_control = clock.clone();
    let (core, containment) = empty_core_with(FakeProvisioner::successful());
    containment.advance_clock_on_next_spawn(clock_control, 1_900_000_000_000);
    let (mut host, actor) = raw_pair(256 * 1024).await;
    let (_shutdown, mut service) =
        SupervisorAsyncService::new(actor, core, clock, TokioSupervisorLifecycleTimer);

    host.send_launch().await;
    let outcome = service.advance().await;
    assert!(matches!(
        outcome,
        SupervisorAsyncServiceAdvance::DriverFailure(SupervisorDriverError::CleanupState(
            CleanupStateError::ClockRegressed
        ))
    ));
    assert_eq!(
        service.status(),
        SupervisorAsyncServiceStatus::HardRestartRequired
    );
    assert!(!service.owner().state().is_accepting_launches());
    assert_eq!(containment.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(containment.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(containment.group_drops.load(Ordering::SeqCst), 0);
    assert_eq!(service.owner().owned_attempts(), 1);
    assert!(service.owner().reserved_memory_bytes() > 0);
    assert!(service.owner().state().pending_cleanup_count() > 0);
    assert!(!service.has_pending_write());
    assert!(matches!(
        service.advance().await,
        SupervisorAsyncServiceAdvance::HardRestartRequired(CleanupStateError::ClockRegressed)
    ));
}
