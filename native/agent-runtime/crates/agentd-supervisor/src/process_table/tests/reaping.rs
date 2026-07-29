use std::cell::RefCell;
use std::rc::Rc;
use std::time::Duration;

use agent_platform::containment::{ProcessId, ResourceGroupId};

use super::super::{
    ContainmentOperationError, ObservedExit, OwnershipError, PhysicalState, ReserveOutcome,
};
use super::fakes::{FakeContainment, FakeError, SuccessfulReaper};
use super::fixtures::{budget, drops, launch, metadata, registry, spawn_running};

#[test]
fn reap_timeout_restores_group_and_token_then_success_releases_admission() {
    let group_drops = drops();
    let mut registry = registry(1);
    let timeout_port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(
        &mut registry,
        &timeout_port,
        metadata("attempt-1", 3, "runtime-1"),
    );
    let observed = ObservedExit {
        exit_code: 23,
        observed_at_unix_ms: 3_000,
    };
    registry
        .mark_exited(&key, observed)
        .expect("exit observation");
    assert!(matches!(
        registry.reap(&timeout_port, &key, Duration::from_millis(1)),
        Err(ContainmentOperationError::Platform(FakeError::TimedOut))
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Reaping));
    assert_eq!(&*timeout_port.reaped_group_ids.borrow(), &[7]);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(group_drops.get(), 0);
    registry
        .mark_exited(&key, observed)
        .expect("idempotent exit replay while reaping");

    let success = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("group-attempt-1".to_owned()),
        process_id: ProcessId(41),
    };
    let reaped = registry
        .reap_with(&success, &key, Duration::from_millis(1))
        .expect("physical reap");

    assert_eq!(&*success.group_ids.borrow(), &[7]);
    assert_eq!(reaped.process_id(), ProcessId(41));
    assert_eq!(reaped.exit_code(), 23);
    assert_eq!(reaped.peak_job_memory_bytes(), 8_192);
    assert_eq!(
        reaped.metadata().resource_group_id,
        ResourceGroupId("group-attempt-1".to_owned())
    );
    assert_eq!(
        reaped.containment_report().level,
        super::fixtures::report().level
    );
    assert!(registry.is_empty());
    assert_eq!(registry.reserved_memory_bytes(), 0);
    assert_eq!(registry.reserved_processes(), 0);
    assert_eq!(group_drops.get(), 1);
}

#[test]
fn terminated_reap_never_invents_exit_before_physical_evidence() {
    let group_drops = drops();
    let mut registry = registry(1);
    let timeout_port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(
        &mut registry,
        &timeout_port,
        metadata("attempt-1", 3, "runtime-1"),
    );
    registry
        .terminate(&timeout_port, &key, 0xE000_0001)
        .expect("termination request");

    assert!(matches!(
        registry.reap_terminated(&timeout_port, &key, Duration::ZERO, 4_000),
        Err(ContainmentOperationError::Platform(FakeError::TimedOut))
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Reaping));
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(group_drops.get(), 0);

    let success = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("group-attempt-1".to_owned()),
        process_id: ProcessId(41),
    };
    let reaped = registry
        .reap_terminated_with(&success, &key, Duration::ZERO, 4_100)
        .expect("physical proof releases admission");

    assert_eq!(
        reaped.observed_exit(),
        ObservedExit {
            exit_code: 23,
            observed_at_unix_ms: 4_100,
        }
    );
    assert_eq!(registry.reserved_memory_bytes(), 0);
    assert_eq!(registry.reserved_processes(), 0);
    assert_eq!(group_drops.get(), 1);
}

#[test]
fn cleanup_reap_preserves_a_cooperative_exit_observation() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let key = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    let observed = ObservedExit {
        exit_code: 17,
        observed_at_unix_ms: 3_000,
    };
    registry.mark_exited(&key, observed).expect("observed exit");
    registry
        .terminate(&port, &key, 0xE000_0001)
        .expect("descendants terminated");
    let success = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("group-attempt-1".to_owned()),
        process_id: ProcessId(41),
    };

    let reaped = registry
        .reap_after_cleanup_with(&success, &key, Duration::ZERO, 4_000)
        .expect("cooperative exit reaped");

    assert_eq!(reaped.observed_exit(), observed);
    assert!(registry.is_empty());
    assert_eq!(registry.reserved_memory_bytes(), 0);
    assert_eq!(registry.reserved_processes(), 0);
    assert_eq!(group_drops.get(), 1);
}

#[test]
fn mismatched_group_reap_evidence_quarantines_ownership_and_admission() {
    let group_drops = drops();
    let mut registry = registry(1);
    let port = FakeContainment::with_group(Rc::clone(&group_drops));
    let owned_metadata = metadata("attempt-1", 3, "runtime-1");
    let key = spawn_running(&mut registry, &port, owned_metadata.clone());
    registry
        .mark_exited(
            &key,
            ObservedExit {
                exit_code: 23,
                observed_at_unix_ms: 3_000,
            },
        )
        .expect("exit observation");
    let mismatched = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("wrong-group".to_owned()),
        process_id: ProcessId(41),
    };

    assert!(matches!(
        registry.reap_with(&mismatched, &key, Duration::from_millis(1)),
        Err(ContainmentOperationError::Ownership(
            OwnershipError::EvidenceAttributionMismatch {
                expected_resource_group_id,
                evidence_resource_group_id,
                expected_process_id: ProcessId(41),
                evidence_process_id: ProcessId(41),
            }
        )) if expected_resource_group_id == ResourceGroupId("group-attempt-1".to_owned())
            && evidence_resource_group_id == ResourceGroupId("wrong-group".to_owned())
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Quarantined));
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert_eq!(group_drops.get(), 1);
    assert_eq!(
        registry.spawn_reserved(&port, owned_metadata, &budget(), &launch()),
        Ok(ReserveOutcome::AlreadyOwned(PhysicalState::Quarantined))
    );
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
    assert!(matches!(
        registry.reap_with(&mismatched, &key, Duration::from_millis(1)),
        Err(ContainmentOperationError::Ownership(
            OwnershipError::InvalidTransition {
                from: PhysicalState::Quarantined,
                requested: PhysicalState::Reaping,
            }
        ))
    ));
    assert_eq!(&*mismatched.group_ids.borrow(), &[7]);
    assert_eq!(port.spawn_calls.get(), 1);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
}

#[test]
fn mismatched_process_reap_evidence_quarantines_ownership_and_admission() {
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
    let mismatched = SuccessfulReaper {
        group_ids: RefCell::new(Vec::new()),
        resource_group_id: ResourceGroupId("group-attempt-1".to_owned()),
        process_id: ProcessId(99),
    };

    assert!(matches!(
        registry.reap_with(&mismatched, &key, Duration::from_millis(1)),
        Err(ContainmentOperationError::Ownership(
            OwnershipError::EvidenceAttributionMismatch {
                expected_resource_group_id,
                evidence_resource_group_id,
                expected_process_id: ProcessId(41),
                evidence_process_id: ProcessId(99),
            }
        )) if expected_resource_group_id == evidence_resource_group_id
    ));
    assert_eq!(registry.state(&key), Ok(PhysicalState::Quarantined));
    assert_eq!(registry.len(), 1);
    assert_eq!(registry.reserved_memory_bytes(), 100);
    assert_eq!(registry.reserved_processes(), 2);
    assert_eq!(group_drops.get(), 1);
}
