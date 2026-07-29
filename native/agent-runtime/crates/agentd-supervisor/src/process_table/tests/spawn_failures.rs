use std::rc::Rc;

use super::super::{ContainmentOperationError, OwnershipKey, PhysicalState};
use super::fakes::{FakeContainment, FakeError};
use super::fixtures::{budget, child_handles, drops, launch, metadata, registry};

#[test]
fn clean_platform_spawn_failure_releases_admission_without_an_entry() {
    let mut registry = registry(1);
    let port = FakeContainment::failing_spawn();

    assert!(matches!(
        registry.spawn_reserved_with_handles(
            &port,
            metadata("attempt-1", 3, "runtime-1"),
            &budget(),
            &launch(),
            child_handles(),
        ),
        Err(ContainmentOperationError::Platform(FakeError::Spawn))
    ));
    assert!(registry.is_empty());
    assert_eq!(registry.reserved_memory_bytes(), 0);
    assert_eq!(registry.reserved_processes(), 0);
    assert_eq!(port.observed_child_handle_counts.borrow().as_slice(), [1]);
}

#[test]
fn owned_platform_spawn_failure_retains_group_and_admission() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::failing_spawn_with_group(Rc::clone(&group_drops));
    let metadata = metadata("attempt-1", 3, "runtime-1");
    let key = OwnershipKey::from_metadata(&metadata);

    assert!(matches!(
        registry.spawn_reserved_with_handles(
            &port,
            metadata,
            &budget(),
            &launch(),
            child_handles()
        ),
        Err(ContainmentOperationError::Platform(FakeError::Spawn))
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Cancelling));
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert_eq!(group_drops.get(), 0);
    assert_eq!(port.observed_child_handle_counts.borrow().as_slice(), [1]);
}
