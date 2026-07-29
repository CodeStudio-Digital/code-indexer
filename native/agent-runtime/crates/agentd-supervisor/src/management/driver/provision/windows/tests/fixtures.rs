use agent_platform::budget::ResourceBudget;
use agent_protocol::generated::v1 as wire;

use super::{Ordering, ProtectedLaunchPeerAuthority, TEST_SEQUENCE};

pub(super) fn next_sequence() -> u64 {
    TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
}

pub(super) fn unix_ms() -> i64 {
    let elapsed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("wall clock after Unix epoch");
    i64::try_from(elapsed.as_millis()).expect("test wall clock fits i64")
}

pub(super) const fn endpoint_kinds() -> [wire::AttemptEndpointKind; 3] {
    [
        wire::AttemptEndpointKind::Control,
        wire::AttemptEndpointKind::Data,
        wire::AttemptEndpointKind::RunnerPulse,
    ]
}

pub(super) const fn endpoint_cap(kind: wire::AttemptEndpointKind) -> usize {
    use agent_protocol::frame::{
        CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES,
    };
    match kind {
        wire::AttemptEndpointKind::Control => CONTROL_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::Data => DATA_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::RunnerPulse => PULSE_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::Unspecified => 0,
    }
}

pub(super) fn peer_authority() -> ProtectedLaunchPeerAuthority {
    let supervisor = std::process::id();
    let host = if supervisor == u32::MAX {
        supervisor - 1
    } else {
        supervisor + 1
    };
    ProtectedLaunchPeerAuthority::new_for_test(host, supervisor, None, None)
        .expect("Windows peer authority")
}

pub(super) fn identity(sequence: u64) -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: format!("11111111-1111-4111-8111-{sequence:012x}"),
        command_id: format!("22222222-2222-4222-8222-{sequence:012x}"),
        agent_run_id: format!("33333333-3333-4333-8333-{sequence:012x}"),
        attempt_id: format!("44444444-4444-4444-8444-{sequence:012x}"),
        executor_owner_id: "supervisor-test".into(),
        fencing_epoch: 1,
        correlation_id: format!("55555555-5555-4555-8555-{sequence:012x}"),
        root_agent_run_id: format!("33333333-3333-4333-8333-{sequence:012x}"),
        ..wire::AttemptIdentity::default()
    }
}

pub(super) fn budget_wire() -> wire::ResourceBudget {
    let budget = budget();
    wire::ResourceBudget {
        soft_memory_bytes: budget.soft_memory_bytes,
        hard_memory_bytes: budget.hard_memory_bytes,
        cpu_time_ms: budget.cpu_time_ms,
        max_wall_ms: budget.max_wall_ms,
        max_processes: budget.max_processes,
        max_threads: budget.max_threads,
        max_open_handles: budget.max_open_handles,
        max_hot_transcript_bytes: budget.max_hot_transcript_bytes,
        max_ipc_frames: budget.max_ipc_frames,
        max_ipc_bytes: budget.max_ipc_bytes,
        max_spool_bytes: budget.max_spool_bytes,
        max_artifact_bytes: budget.max_artifact_bytes,
        max_concurrent_tools: budget.max_concurrent_tools,
        max_blocking_tasks: budget.max_blocking_tasks,
        cancel_grace_ms: budget.cancel_grace_ms,
    }
}

const fn budget() -> ResourceBudget {
    ResourceBudget {
        soft_memory_bytes: 128 * 1024 * 1024,
        hard_memory_bytes: 256 * 1024 * 1024,
        cpu_time_ms: 30_000,
        max_wall_ms: 30_000,
        max_processes: 2,
        max_threads: 32,
        max_open_handles: 256,
        max_hot_transcript_bytes: 1024,
        max_ipc_frames: 32,
        // Data v1 reserves 64 KiB for its envelope before granting payload
        // credit, so a materializable launch must exceed that floor.
        max_ipc_bytes: 1024 * 1024,
        max_spool_bytes: 4096,
        max_artifact_bytes: 2048,
        max_concurrent_tools: 1,
        max_blocking_tasks: 1,
        cancel_grace_ms: 1000,
    }
}
