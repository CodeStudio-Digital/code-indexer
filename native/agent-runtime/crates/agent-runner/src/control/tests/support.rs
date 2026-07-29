use agent_protocol::activation_authority::activation_nonce_sha256;
use agent_protocol::frame::CONTROL_FRAME_MAX_BYTES;
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::{ConnectionId, RuntimeInstanceId};
use agent_protocol::version::ProtocolVersion;
use agent_protocol::wire_identity::identity_from_wire;

use crate::control::{EffectivePreparedFacts, RunnerLaunchContext};

mod launch;
mod messages;
mod transport;

pub(super) use messages::{
    CANCEL_GRACE_DEADLINE, FENCED_AT, activate_frame_with, activate_frame_with_deadline,
    attempt_frames, cancel_frame, cancel_frame_with, decode_written_frames,
    decode_written_raw_frames, fence_frame, fence_frame_with, host_hello_frame,
    host_hello_frame_for_connection, host_hello_frame_with, prepare_frame,
};
pub(super) use transport::{
    FailWriter, ManualClock, SharedWriter, driver_with_clock, driver_with_frames,
};

pub(super) const CONNECTION_ID: &str = "connection-1";
pub(super) const CONTRACT_VERSION: &str = "contract-v1";
pub(super) const LAUNCH_DEADLINE: i64 = 10_000;
pub(super) const SPEC_DEADLINE: i64 = 9_000;
pub(super) const LAUNCH_NONCE: &[u8] = &[7; 32];
pub(super) const CONNECTION_SESSION_TOKEN: &[u8] = &[9; 32];
pub(super) const RUNTIME_ID: &str = "runtime-1";
pub(super) const ACTIVATION_NONCE: &[u8] = b"activation-nonce";
pub(super) const AGENT_RUN_VERSION: u64 = 8;
pub(super) const ATTEMPT_VERSION: u64 = 5;

pub(super) fn wire_identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".to_owned(),
        command_id: "22222222-2222-4222-8222-222222222222".to_owned(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".to_owned(),
        attempt_id: "44444444-4444-4444-8444-444444444444".to_owned(),
        executor_owner_id: "runner-owner-1".to_owned(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".to_owned(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".to_owned(),
        owner_agent_run_id: None,
        parent_agent_run_id: None,
    }
}

pub(super) const fn resource_budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 32 * 1024 * 1024,
        hard_memory_bytes: 64 * 1024 * 1024,
        cpu_time_ms: 1_000,
        max_wall_ms: 2_000,
        max_processes: 4,
        max_threads: 8,
        max_open_handles: 64,
        max_hot_transcript_bytes: 16 * 1024,
        max_ipc_frames: 128,
        max_ipc_bytes: 1024 * 1024,
        max_spool_bytes: 64 * 1024,
        max_artifact_bytes: 32 * 1024,
        max_concurrent_tools: 2,
        max_blocking_tasks: 2,
        cancel_grace_ms: 100,
    }
}

pub(super) fn snapshot(name: &str) -> wire::SnapshotRef {
    wire::SnapshotRef {
        r#ref: format!("snapshot:{name}"),
        version: 1,
        content_sha256: vec![7; 32],
        origin: "host".to_owned(),
        schema_id: format!("codestudio.{name}.v1"),
        schema_version: 1,
    }
}

pub(super) fn agent_hello() -> wire::AgentHello {
    wire::AgentHello {
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
            maximum: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        }),
        contract_version: CONTRACT_VERSION.to_owned(),
        contract_schema_version: 1,
        provenance: Some(wire::RuntimeProvenance {
            build_id: "fixture-build".to_owned(),
            source_commit: "fixture-commit".to_owned(),
            binary_sha256: vec![3; 32],
            runtime_instance_id: RUNTIME_ID.to_owned(),
            pid: 42,
            operating_system: "windows".to_owned(),
            architecture: "x86_64".to_owned(),
        }),
        launch_nonce: LAUNCH_NONCE.to_vec(),
        containment: Some(containment_capabilities()),
        supported_feature_bits: 0,
        native_capabilities: Vec::new(),
    }
}

pub(super) fn host_hello() -> wire::HostHello {
    wire::HostHello {
        selected_protocol: Some(wire::ProtocolVersion { major: 1, minor: 1 }),
        connection_id: CONNECTION_ID.to_owned(),
        contract_version: CONTRACT_VERSION.to_owned(),
        contract_schema_version: 1,
        heartbeat_interval_ms: 1_000,
        heartbeat_timeout_ms: 3_000,
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: CONTROL_FRAME_MAX_BYTES as u64,
            max_chunk_bytes: 64 * 1024,
            max_in_flight_frames: 4,
            max_in_flight_bytes: (CONTROL_FRAME_MAX_BYTES * 4) as u64,
            read_timeout_ms: 1_000,
            write_timeout_ms: 1_000,
            transport_crc32c: false,
        }),
        connection_session_token: CONNECTION_SESSION_TOKEN.to_vec(),
        allowed_feature_bits: 0,
        required_feature_bits: 0,
    }
}

pub(super) fn launch_context() -> RunnerLaunchContext {
    RunnerLaunchContext::new(
        identity_from_wire(&wire_identity()).expect("semantic identity"),
        RuntimeInstanceId::new(RUNTIME_ID).expect("runtime ID"),
        ConnectionId::new(CONNECTION_ID).expect("connection ID"),
        LAUNCH_NONCE,
        CONNECTION_SESSION_TOKEN,
        &activation_authority_seal(),
        LAUNCH_DEADLINE,
        resource_budget(),
        wire::ContainmentLevel::HardAggregate,
        vec![
            wire::ResourceLimitKind::Memory,
            wire::ResourceLimitKind::CpuTime,
            wire::ResourceLimitKind::Processes,
        ],
    )
    .expect("launch context")
}

pub(super) fn activation_authority_seal() -> wire::ActivationAuthoritySeal {
    wire::ActivationAuthoritySeal {
        agent_run_version: AGENT_RUN_VERSION,
        attempt_version: ATTEMPT_VERSION,
        activation_nonce_sha256: activation_nonce_sha256(ACTIVATION_NONCE).to_vec(),
    }
}

pub(super) fn effective_facts(ready_at_unix_ms: i64) -> EffectivePreparedFacts {
    EffectivePreparedFacts::from_verified_platform(
        required_snapshots(&valid_spec()),
        Vec::new(),
        resource_budget(),
        wire::ContainmentReport {
            level: wire::ContainmentLevel::HardAggregate as i32,
            enforced_limits: vec![
                wire::ResourceLimitKind::Memory as i32,
                wire::ResourceLimitKind::CpuTime as i32,
                wire::ResourceLimitKind::Processes as i32,
            ],
            unsupported_limits: vec![
                wire::ResourceLimitKind::WallTime as i32,
                wire::ResourceLimitKind::Threads as i32,
                wire::ResourceLimitKind::OpenHandles as i32,
                wire::ResourceLimitKind::ScratchBytes as i32,
            ],
            capabilities: Some(containment_capabilities()),
        },
        ready_at_unix_ms,
    )
}

pub(super) fn valid_spec() -> wire::ResolvedAttemptSpec {
    messages::valid_spec()
}

pub(super) fn required_snapshots(spec: &wire::ResolvedAttemptSpec) -> Vec<wire::SnapshotRef> {
    [
        spec.verifier_policy_snapshot.clone(),
        spec.capability_set_snapshot.clone(),
        spec.environment_snapshot.clone(),
        spec.workspace_lease_snapshot.clone(),
        spec.policy_snapshot.clone(),
        spec.preset_snapshot.clone(),
        spec.agent_definition_snapshot.clone(),
    ]
    .into_iter()
    .map(|value| value.expect("required fixture snapshot"))
    .collect()
}

pub(super) fn frame_header(message_id: &str, stream_seq: u64, deadline: i64) -> wire::FrameHeader {
    let identity = wire_identity();
    wire::FrameHeader {
        protocol_version: ProtocolVersion::new(1, 1).to_wire(),
        connection_id: CONNECTION_ID.to_owned(),
        message_id: message_id.to_owned(),
        session_id: identity.session_id,
        command_id: identity.command_id,
        agent_run_id: identity.agent_run_id,
        attempt_id: identity.attempt_id,
        executor_owner_id: identity.executor_owner_id,
        fencing_epoch: identity.fencing_epoch,
        correlation_id: identity.correlation_id,
        stream_seq,
        sent_at_unix_ms: 900,
        deadline_at_unix_ms: Some(deadline),
        root_agent_run_id: identity.root_agent_run_id,
        owner_agent_run_id: identity.owner_agent_run_id,
        parent_agent_run_id: identity.parent_agent_run_id,
        ..wire::FrameHeader::default()
    }
}

const fn containment_capabilities() -> wire::ContainmentCapabilities {
    wire::ContainmentCapabilities {
        process_tree: true,
        memory_limit: true,
        cpu_limit: true,
        process_count_limit: true,
        open_file_limit: false,
        filesystem_quota: false,
        network_policy: false,
    }
}
pub(super) use launch::{agent_hello_draft, launch_nonce_authority};
