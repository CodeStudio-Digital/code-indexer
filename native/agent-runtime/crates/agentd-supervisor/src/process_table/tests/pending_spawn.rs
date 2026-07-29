use std::time::Duration;

use agent_platform::containment::ContainmentPort;

use super::super::{
    ContainmentOperationError, OwnershipError, PendingSpawn, PendingSpawnFinishError,
    PendingSpawnReservation, PhysicalState, SpawnHandoffState,
};
use super::fakes::{FakeContainment, FakeError, FakeGroup};
use super::fixtures::{budget, child_handles, drops, launch, metadata, registry};

fn reserve(
    registry: &mut super::super::OwnershipRegistry<FakeGroup>,
    attempt: super::super::AttemptRuntimeMetadata,
) -> PendingSpawn {
    match registry
        .reserve_pending_spawn(attempt, &budget())
        .expect("reserve pending spawn")
    {
        PendingSpawnReservation::Reserved(pending) => *pending,
        PendingSpawnReservation::AlreadyOwned(state) => {
            panic!("unexpected existing ownership: {state:?}")
        }
    }
}

#[test]
fn reserves_ledger_and_launching_entry_before_the_spawn_effect() {
    let drops = drops();
    let port = FakeContainment::with_group(drops);
    let mut registry = registry(1);
    let attempt = metadata("attempt-pending-reserve", 1, "runtime-a");
    let key = super::super::OwnershipKey::from_metadata(&attempt);
    let group_id = attempt.resource_group_id.clone();

    let pending = reserve(&mut registry, attempt);

    assert_eq!(port.spawn_calls.get(), 0);
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert_eq!(registry.state(&key), Ok(PhysicalState::Reserved));
    assert_eq!(
        registry.spawn_handoff_state(&key),
        Ok(Some(SpawnHandoffState::Launching))
    );
    assert_eq!(registry.bootstrap_pending(&key), Ok(false));

    let result =
        port.spawn_runner_contained_with_handles(group_id, &budget(), &launch(), child_handles());
    registry
        .finish_pending_spawn(pending, result)
        .expect("finish physical spawn");
    assert_eq!(
        registry.spawn_handoff_state(&key),
        Ok(Some(SpawnHandoffState::BootstrapPending))
    );
    assert_eq!(registry.bootstrap_pending(&key), Ok(true));
}

#[test]
fn clean_spawn_failure_releases_the_launching_reservation() {
    let port = FakeContainment::failing_spawn();
    let mut registry = registry(1);
    let attempt = metadata("attempt-clean-failure", 1, "runtime-a");
    let group_id = attempt.resource_group_id.clone();
    let pending = reserve(&mut registry, attempt);
    let result =
        port.spawn_runner_contained_with_handles(group_id, &budget(), &launch(), child_handles());

    let failure = registry
        .finish_pending_spawn(pending, result)
        .expect_err("clean spawn failure");

    assert!(matches!(
        failure,
        PendingSpawnFinishError::Operation(ContainmentOperationError::Platform(FakeError::Spawn))
    ));
    assert!(registry.is_empty());
    assert_eq!(registry.reserved_memory_bytes(), 0);
    assert_eq!(registry.reserved_processes(), 0);
}

#[test]
fn owned_spawn_failure_retains_group_and_reservation_as_cancelling() {
    let drops = drops();
    let port = FakeContainment::failing_spawn_with_group(drops.clone());
    let mut registry = registry(1);
    let attempt = metadata("attempt-owned-failure", 1, "runtime-a");
    let key = super::super::OwnershipKey::from_metadata(&attempt);
    let group_id = attempt.resource_group_id.clone();
    let pending = reserve(&mut registry, attempt);
    let result =
        port.spawn_runner_contained_with_handles(group_id, &budget(), &launch(), child_handles());

    let failure = registry
        .finish_pending_spawn(pending, result)
        .expect_err("owned spawn failure");

    assert!(matches!(
        failure,
        PendingSpawnFinishError::Operation(ContainmentOperationError::Platform(FakeError::Spawn))
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Cancelling));
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert_eq!(drops.get(), 0);
}

#[test]
fn cancellation_during_launching_is_applied_after_spawn_returns() {
    let drops = drops();
    let port = FakeContainment::with_group(drops);
    let mut registry = registry(1);
    let attempt = metadata("attempt-cancel-launching", 1, "runtime-a");
    let key = super::super::OwnershipKey::from_metadata(&attempt);
    let group_id = attempt.resource_group_id.clone();
    let pending = reserve(&mut registry, attempt);

    registry
        .terminate(&port, &key, 91)
        .expect("record termination while launching");
    assert_eq!(port.terminate_calls.get(), 0);

    let result =
        port.spawn_runner_contained_with_handles(group_id, &budget(), &launch(), child_handles());
    let finished = registry
        .finish_pending_spawn(pending, result)
        .expect("finish cancelled spawn");
    assert_eq!(finished.pending_termination_exit_code(), Some(91));
    assert_eq!(registry.bootstrap_pending(&key), Ok(true));

    registry
        .terminate(&port, finished.key(), 91)
        .expect("apply deferred termination");
    assert_eq!(port.terminate_calls.get(), 1);
    assert_eq!(
        registry.mark_bootstrap_complete(&key),
        Ok(PhysicalState::Cancelling)
    );
    assert_eq!(registry.spawn_handoff_state(&key), Ok(None));
    assert_eq!(registry.bootstrap_pending(&key), Ok(false));
}

#[test]
fn reap_is_blocked_until_bootstrap_completion_is_marked() {
    let drops = drops();
    let port = FakeContainment::with_group(drops);
    let mut registry = registry(1);
    let attempt = metadata("attempt-reap-bootstrap", 1, "runtime-a");
    let key = super::super::OwnershipKey::from_metadata(&attempt);
    let group_id = attempt.resource_group_id.clone();
    let pending = reserve(&mut registry, attempt);
    let result =
        port.spawn_runner_contained_with_handles(group_id, &budget(), &launch(), child_handles());
    registry
        .finish_pending_spawn(pending, result)
        .expect("finish physical spawn");
    registry
        .terminate(&port, &key, 92)
        .expect("terminate bootstrap-pending group");

    let blocked = registry
        .reap_terminated(&port, &key, Duration::from_millis(1), 100)
        .expect_err("bootstrap-pending reap must fail");
    assert!(matches!(
        blocked,
        ContainmentOperationError::Ownership(OwnershipError::InvalidTransition {
            from: PhysicalState::Reserved,
            requested: PhysicalState::Reaping,
        })
    ));
    assert!(port.reaped_group_ids.borrow().is_empty());

    assert_eq!(
        registry.mark_bootstrap_complete(&key),
        Ok(PhysicalState::Cancelling)
    );
    let reaping = registry
        .reap_terminated(&port, &key, Duration::from_millis(1), 100)
        .expect_err("fake reaper returns its owned group");
    assert!(matches!(
        reaping,
        ContainmentOperationError::Platform(FakeError::TimedOut)
    ));
    assert_eq!(port.reaped_group_ids.borrow().as_slice(), &[7]);
    assert_eq!(registry.state(&key), Ok(PhysicalState::Reaping));
}
