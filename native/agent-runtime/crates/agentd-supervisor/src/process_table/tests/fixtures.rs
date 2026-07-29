use std::cell::Cell;
use std::ffi::OsString;
use std::fs::File;
use std::path::PathBuf;
use std::rc::Rc;

use agent_platform::budget::ResourceBudget;
use agent_platform::containment::{
    ChildHandleAllowlist, ContainedLaunch, ContainmentCapabilities, ContainmentLevel,
    ContainmentReport, LimitKind, ResourceGroupId,
};
use agent_protocol::identity::{
    AgentRunId, AttemptId, AttemptIdentity, CommandId, CorrelationId, ExecutorOwnerId,
    RuntimeInstanceId, SessionId,
};

use super::super::{AttemptRuntimeMetadata, OwnershipKey, OwnershipRegistry, ReserveOutcome};
use super::fakes::{FakeContainment, FakeGroup};
use crate::admission::SupervisorCapacity;

pub(super) fn identity(attempt: &str, fence: u64) -> AttemptIdentity {
    let attempt = match attempt {
        "attempt-1" => "44444444-4444-4444-8444-444444444444",
        "attempt-2" => "99999999-9999-4999-8999-999999999999",
        "attempt-pending-reserve" => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        "attempt-cancel-launching" => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        "attempt-clean-failure" => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        "attempt-owned-failure" => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4",
        "attempt-reap-bootstrap" => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5",
        other => panic!("unknown attempt fixture label: {other}"),
    };
    AttemptIdentity {
        session_id: SessionId::new("11111111-1111-4111-8111-111111111111").expect("valid ID"),
        command_id: CommandId::new("22222222-2222-4222-8222-222222222222").expect("valid ID"),
        agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333").expect("valid ID"),
        attempt_id: AttemptId::new(attempt).expect("valid ID"),
        executor_owner_id: ExecutorOwnerId::new("owner").expect("valid ID"),
        fencing_epoch: fence,
        correlation_id: CorrelationId::new("55555555-5555-4555-8555-555555555555")
            .expect("valid ID"),
        root_agent_run_id: AgentRunId::new("33333333-3333-4333-8333-333333333333")
            .expect("valid ID"),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

pub(super) fn metadata(attempt: &str, fence: u64, runtime: &str) -> AttemptRuntimeMetadata {
    AttemptRuntimeMetadata {
        identity: identity(attempt, fence),
        runtime_instance_id: RuntimeInstanceId::new(runtime).expect("valid ID"),
        resource_group_id: ResourceGroupId(format!("group-{attempt}")),
        deadline_at_unix_ms: 2_000,
        lease_expires_at_unix_ms: 1_500,
        cancel_grace_ms: 1_000,
    }
}

pub(super) fn budget() -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 50,
        hard_memory_bytes: 100,
        cpu_time_ms: 60_000,
        max_wall_ms: 60_000,
        max_processes: 2,
        max_threads: 16,
        max_open_handles: 128,
        max_hot_transcript_bytes: 1_024,
        max_ipc_frames: 64,
        max_ipc_bytes: 65_536,
        max_spool_bytes: 1_024,
        max_artifact_bytes: 1_024,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 1_000,
    }
}

pub(super) fn registry(capacity: u32) -> OwnershipRegistry<FakeGroup> {
    OwnershipRegistry::new(SupervisorCapacity {
        max_active_attempts: capacity,
        max_reserved_memory_bytes: 1_000,
        max_reserved_processes: 20,
    })
    .expect("valid capacity")
}

pub(super) fn report() -> ContainmentReport {
    ContainmentReport {
        level: ContainmentLevel::HardAggregate,
        enforced_limits: Vec::new(),
        unsupported_limits: vec![
            LimitKind::Memory,
            LimitKind::CpuTime,
            LimitKind::WallTime,
            LimitKind::Processes,
            LimitKind::Threads,
            LimitKind::OpenHandles,
            LimitKind::ScratchBytes,
        ],
        capabilities: ContainmentCapabilities {
            process_tree: true,
            ..ContainmentCapabilities::default()
        },
    }
}

pub(super) fn launch() -> ContainedLaunch {
    ContainedLaunch {
        executable: PathBuf::from("runner"),
        arguments: Vec::<OsString>::new(),
        working_directory: PathBuf::from("."),
        environment: Vec::new(),
    }
}

pub(super) fn child_handles() -> ChildHandleAllowlist {
    let owner = File::open(std::env::current_exe().expect("test executable path"))
        .expect("test executable handle");
    let mut handles = ChildHandleAllowlist::new();
    #[cfg(windows)]
    handles
        .prepare_windows(&owner)
        .expect("dedicated Windows child handle");
    #[cfg(unix)]
    handles
        .prepare_unix(&owner)
        .expect("dedicated Unix child descriptor");
    handles
}

pub(super) fn spawn_reserved_entry(
    registry: &mut OwnershipRegistry<FakeGroup>,
    port: &FakeContainment,
    metadata: AttemptRuntimeMetadata,
) -> OwnershipKey {
    let key = OwnershipKey::from_metadata(&metadata);
    let outcome = registry
        .spawn_reserved(port, metadata, &budget(), &launch())
        .expect("spawn reserved");
    assert_eq!(outcome, ReserveOutcome::Reserved);
    key
}

pub(super) fn spawn_running(
    registry: &mut OwnershipRegistry<FakeGroup>,
    port: &FakeContainment,
    metadata: AttemptRuntimeMetadata,
) -> OwnershipKey {
    let key = spawn_reserved_entry(registry, port, metadata);
    registry.mark_running(&key).expect("mark running");
    registry
        .mark_running(&key)
        .expect("idempotent running retry");
    key
}

pub(super) fn drops() -> Rc<Cell<u32>> {
    Rc::new(Cell::new(0))
}
