use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use agent_platform::containment::{ProcessId, ResourceGroupId};

use super::super::{
    ContainmentOperationError, OwnershipError, PhysicalState, ReapAfterCleanupError,
};
use super::fakes::{FakeContainment, SuccessfulReaper};
use super::fixtures::{budget, drops, launch, metadata, registry, spawn_running};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GateError {
    DeadlineElapsed,
}

#[test]
fn successful_reap_denied_by_post_gate_quarantines_and_retains_admission() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    registry
        .terminate(&port, &key, 0xE000_0001)
        .expect("termination request");
    let success = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("group-attempt-1".to_owned()),
        process_id: ProcessId(41),
    };

    assert_eq!(
        registry.reap_after_cleanup_with_gate(
            &success,
            &key,
            Duration::ZERO,
            || { Err(GateError::DeadlineElapsed) },
            |_, _| panic!("clock failure cannot publish evidence")
        ),
        Err(ReapAfterCleanupError::PostReapGate(
            GateError::DeadlineElapsed
        ))
    );

    assert_eq!(&*success.group_ids.borrow(), &[7]);
    assert_eq!(group_drops.get(), 1);
    assert_eq!(registry.state(&key), Ok(PhysicalState::Quarantined));
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert!(matches!(
        registry.spawn_reserved(
            &port,
            metadata("attempt-2", 3, "runtime-2"),
            &budget(),
            &launch(),
        ),
        Err(ContainmentOperationError::Ownership(
            OwnershipError::CapacityExceeded
        ))
    ));
}

#[test]
fn evidence_commit_failure_quarantines_without_releasing_admission() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    registry
        .terminate(&port, &key, 0xE000_0001)
        .expect("termination");
    let success = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("group-attempt-1".to_owned()),
        process_id: ProcessId(41),
    };
    let result = registry.reap_after_cleanup_with_gate(
        &success,
        &key,
        Duration::ZERO,
        || Ok(2_000),
        |reaped, at| {
            assert_eq!(reaped.process_id(), ProcessId(41));
            assert_eq!(at, 2_000);
            Err("outbox unavailable")
        },
    );
    assert_eq!(
        result,
        Err(ReapAfterCleanupError::PostReapGate("outbox unavailable"))
    );
    assert_eq!(registry.state(&key), Ok(PhysicalState::Quarantined));
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert_eq!(group_drops.get(), 1);
}
