use std::rc::Rc;
use std::time::Duration;

use agent_protocol::identity::ExecutorOwnerId;

use super::super::{
    ContainmentOperationError, ObservedExit, OwnershipError, OwnershipKey, PhysicalState,
    ReserveOutcome,
};
use super::fakes::{FakeContainment, FakeError};
use super::fixtures::{
    budget, child_handles, drops, launch, metadata, registry, spawn_reserved_entry, spawn_running,
};

#[test]
fn capacity_and_exact_reservation_retry_are_bounded_and_idempotent() {
    let mut registry = registry(1);
    let first = metadata("attempt-1", 3, "runtime-1");
    let port = FakeContainment::with_group(drops());

    assert_eq!(
        registry.spawn_reserved(&port, first.clone(), &budget(), &launch()),
        Ok(ReserveOutcome::Reserved)
    );
    assert_eq!(
        registry.spawn_reserved(&port, first, &budget(), &launch()),
        Ok(ReserveOutcome::AlreadyOwned(PhysicalState::Reserved))
    );
    assert!(matches!(
        registry.spawn_reserved(
            &port,
            metadata("attempt-2", 3, "runtime-2"),
            &budget(),
            &launch()
        ),
        Err(ContainmentOperationError::Ownership(
            OwnershipError::CapacityExceeded
        ))
    ));
    assert_eq!(port.spawn_calls.get(), 1);
    assert_eq!(port.observed_child_handle_counts.borrow().as_slice(), [0]);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
}

#[test]
fn explicit_child_handles_reach_successful_containment_spawn() {
    let mut registry = registry(1);
    let port = FakeContainment::with_group(drops());

    assert_eq!(
        registry.spawn_reserved_with_handles(
            &port,
            metadata("attempt-1", 3, "runtime-1"),
            &budget(),
            &launch(),
            child_handles(),
        ),
        Ok(ReserveOutcome::Reserved)
    );
    assert_eq!(port.observed_child_handle_counts.borrow().as_slice(), [1]);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
}

#[test]
fn stale_fence_identity_and_runtime_never_touch_the_current_group() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let current = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    let mut stale_identity = metadata("attempt-1", 3, "runtime-1");
    stale_identity.identity.executor_owner_id =
        ExecutorOwnerId::new("old-owner").expect("valid ID");

    for stale in [
        OwnershipKey::from_metadata(&metadata("attempt-1", 2, "runtime-1")),
        OwnershipKey::from_metadata(&metadata("attempt-1", 3, "runtime-old")),
        OwnershipKey::from_metadata(&stale_identity),
    ] {
        assert!(matches!(
            registry.terminate(&port, &stale, 9),
            Err(ContainmentOperationError::Ownership(
                OwnershipError::StaleOwnership
            ))
        ));
    }
    assert_eq!(registry.state(&current), Ok(PhysicalState::Running));
    assert_eq!(port.terminate_calls.get(), 0);
    assert_eq!(group_drops.get(), 0);
}

#[test]
fn termination_failure_keeps_noncloneable_ownership_in_cancelling() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    port.fail_terminate.set(true);

    assert!(matches!(
        registry.terminate(&port, &key, 9),
        Err(ContainmentOperationError::Platform(FakeError::Termination))
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Cancelling));
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(group_drops.get(), 0);
}

#[test]
fn bootstrap_crash_transitions_reserved_group_to_exited() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_reserved_entry(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));

    registry
        .mark_exited(
            &key,
            ObservedExit {
                exit_code: 70,
                observed_at_unix_ms: 2_500,
            },
        )
        .expect("bootstrap exit observation");

    assert_eq!(registry.state(&key), Ok(PhysicalState::Exited));
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(group_drops.get(), 0);
}

#[test]
fn termination_after_root_exit_still_targets_descendants_and_preserves_state() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    registry
        .mark_exited(
            &key,
            ObservedExit {
                exit_code: 23,
                observed_at_unix_ms: 3_000,
            },
        )
        .expect("exit observation");

    registry
        .terminate(&port, &key, 9)
        .expect("terminate descendants after root exit");
    assert_eq!(registry.state(&key), Ok(PhysicalState::Exited));
    assert_eq!(port.terminate_calls.get(), 1);

    assert!(matches!(
        registry.reap(&port, &key, Duration::from_millis(1)),
        Err(ContainmentOperationError::Platform(FakeError::TimedOut))
    ));
    registry
        .terminate(&port, &key, 9)
        .expect("terminate descendants after reap timeout");
    assert_eq!(registry.state(&key), Ok(PhysicalState::Reaping));
    assert_eq!(port.terminate_calls.get(), 2);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(group_drops.get(), 0);
}
