use std::time::Duration;

use crate::containment::{
    ContainmentLevel, ContainmentPort, LimitKind, ResourceGroupId, SpawnFailure,
};

use super::super::{WindowsContainment, WindowsContainmentError, sys};
use super::{TERMINATED_EXIT_CODE, budget, inert_launch, spawn};

#[test]
fn job_list_membership_is_proven_before_return() {
    let adapter = WindowsContainment::new();
    let spawned = spawn("membership");

    assert!(sys::is_member(&spawned.group.job, &spawned.group.root_process).expect("membership"));
    assert_eq!(spawned.report.level, ContainmentLevel::HardAggregate);
    assert_eq!(
        spawned.report.enforced_limits,
        vec![LimitKind::Memory, LimitKind::CpuTime, LimitKind::Processes]
    );
    terminate_and_reap(&adapter, spawned.group);
}

#[test]
fn terminate_and_reap_attributes_linear_evidence() {
    let adapter = WindowsContainment::new();
    let spawned = spawn("terminate-reap");
    let process_id = spawned.process_id;

    adapter
        .terminate_group(&spawned.group, TERMINATED_EXIT_CODE)
        .expect("terminate group");
    let evidence = adapter
        .reap_group(spawned.group, Duration::from_secs(2))
        .expect("physical reap");

    assert_eq!(
        evidence.resource_group_id(),
        &ResourceGroupId("terminate-reap".into())
    );
    assert_eq!(evidence.process_id(), process_id);
    assert_eq!(evidence.exit_code(), TERMINATED_EXIT_CODE);
}

#[test]
fn descendant_is_created_inside_job_and_dies_on_last_handle_close() {
    let adapter = WindowsContainment::new();
    let spawned = spawn("descendant");
    let descendant = adapter
        .spawn_descendant_contained(&spawned.group, &inert_launch())
        .expect("contained descendant");
    let descendant_handle = sys::open_process_for_wait(descendant.0).expect("descendant handle");

    assert!(sys::is_member(&spawned.group.job, &descendant_handle).expect("descendant membership"));
    let root_handle =
        sys::open_process_for_wait(spawned.process_id.0).expect("independent root handle");
    drop(spawned.group);
    assert_signaled(&root_handle);
    assert_signaled(&descendant_handle);
}

#[test]
fn active_process_cap_rejects_descendant_without_losing_root() {
    let adapter = WindowsContainment::new();
    let mut one_process = budget();
    one_process.max_processes = 1;
    let spawned = adapter
        .spawn_runner_contained(
            ResourceGroupId("process-cap".into()),
            &one_process,
            &inert_launch(),
        )
        .expect("single-process group");

    adapter
        .spawn_descendant_contained(&spawned.group, &inert_launch())
        .expect_err("JOB_LIST assignment must enforce active process cap");
    assert_eq!(
        sys::wait_process(&spawned.group.root_process, 0).expect("root wait"),
        sys::WaitState::TimedOut
    );
    terminate_and_reap(&adapter, spawned.group);
}

#[test]
fn reap_timeout_returns_the_same_owned_group() {
    let adapter = WindowsContainment::new();
    let spawned = spawn("timeout-ownership");
    let process_id = spawned.process_id;
    let failure = adapter
        .reap_group(spawned.group, Duration::ZERO)
        .expect_err("live process cannot be reaped");

    assert!(matches!(
        failure.error,
        WindowsContainmentError::ReapTimedOut(Duration::ZERO)
    ));
    assert_eq!(failure.group.process_id(), process_id);
    terminate_and_reap(&adapter, failure.group);
}

#[test]
fn injected_post_create_failure_is_explicitly_cleaned() {
    let failure = WindowsContainment::spawn_runner_with_fault(
        ResourceGroupId("cleanup".into()),
        &budget(),
        &inert_launch(),
        sys::SpawnFault::AfterCreate,
    )
    .expect_err("fault must fail launch");

    assert!(matches!(failure, SpawnFailure::Clean(_)));
}

#[test]
fn failed_post_create_cleanup_returns_linear_group_ownership() {
    let adapter = WindowsContainment::new();
    let failure = WindowsContainment::spawn_runner_with_fault(
        ResourceGroupId("owned-failure".into()),
        &budget(),
        &inert_launch(),
        sys::SpawnFault::AfterCreateWithCleanupFailure,
    )
    .expect_err("fault must return ownership");
    let SpawnFailure::Owned { spawned, error } = failure else {
        panic!("cleanup failure lost physical ownership");
    };
    let spawned = *spawned;

    assert!(matches!(
        error,
        WindowsContainmentError::StartupCleanupFailed { .. }
    ));
    assert!(sys::is_member(&spawned.group.job, &spawned.group.root_process).expect("membership"));
    terminate_and_reap(&adapter, spawned.group);
}

fn terminate_and_reap(adapter: &WindowsContainment, group: super::super::WindowsJobGroup) {
    adapter
        .terminate_group(&group, TERMINATED_EXIT_CODE)
        .expect("terminate group");
    adapter
        .reap_group(group, Duration::from_secs(2))
        .expect("reap group");
}

fn assert_signaled(process: &std::os::windows::io::OwnedHandle) {
    assert_eq!(
        sys::wait_process(process, 2_000).expect("bounded process wait"),
        sys::WaitState::Signaled
    );
}
