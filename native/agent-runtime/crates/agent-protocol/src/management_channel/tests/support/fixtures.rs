use crate::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_channel::{
    ManagementDeadlinePolicy, ManagementReplayLimits, PendingManagementInbound,
};
use crate::management_frame::MANAGEMENT_FRAME_MAX_BYTES;
use crate::version::ProtocolVersion;

pub const NOW: i64 = 100;
pub const CONNECTION: &str = "management:test-connection";
pub const SUPERVISOR_NONCE: [u8; 32] = [9; 32];
pub const MANAGEMENT_TOKEN: [u8; 32] = [8; 32];

pub fn protocol() -> ProtocolVersion {
    ProtocolVersion::new(1, 1)
}

pub fn connection() -> ConnectionId {
    ConnectionId::new(CONNECTION).expect("connection")
}

pub fn limits() -> ManagementReplayLimits {
    ManagementReplayLimits::new(4, 16, MANAGEMENT_FRAME_MAX_BYTES * 4).expect("limits")
}

pub fn deadline(timeout_ms: u64) -> ManagementDeadlinePolicy {
    ManagementDeadlinePolicy::new(timeout_ms).expect("deadline policy")
}

pub fn hard_cap_u32() -> u32 {
    u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management hard cap fits u32")
}

pub fn host_hello() -> wire::HostSupervisorHello {
    wire::HostSupervisorHello {
        selected_protocol: Some(version()),
        connection_id: CONNECTION.into(),
        contract_version: "contract:test-v1".into(),
        contract_schema_version: 1,
        expected_supervisor_provenance: Some(expected_provenance()),
        allowed_runner_provenance: vec![expected_provenance()],
        limits: Some(wire::SupervisorLimits {
            max_active_attempts: 8,
            max_pending_launches: 8,
            max_reserved_memory_bytes: 8 * 1024 * 1024 * 1024,
            max_reserved_processes: 64,
            host_disconnect_grace_ms: 10_000,
            runner_pulse_timeout_ms: 5_000,
        }),
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: MANAGEMENT_FRAME_MAX_BYTES as u64,
            max_chunk_bytes: 16 * 1024,
            max_in_flight_frames: 32,
            max_in_flight_bytes: 2 * 1024 * 1024,
            read_timeout_ms: 10_000,
            write_timeout_ms: 10_000,
            ..wire::FrameLimits::default()
        }),
        management_session_token: MANAGEMENT_TOKEN.to_vec(),
        required_containment_level: wire::ContainmentLevel::Monitored as i32,
        ..wire::HostSupervisorHello::default()
    }
}

pub fn supervisor_hello() -> wire::SupervisorHello {
    wire::SupervisorHello {
        supported_protocols: Some(wire::ProtocolVersionRange {
            minimum: Some(version()),
            maximum: Some(version()),
        }),
        contract_version: "contract:test-v1".into(),
        contract_schema_version: 1,
        provenance: Some(wire::RuntimeProvenance {
            build_id: "supervisor-build".into(),
            source_commit: "source-commit".into(),
            binary_sha256: vec![1; 32],
            runtime_instance_id: "runtime:test".into(),
            pid: 42,
            operating_system: "windows".into(),
            architecture: "x86_64".into(),
        }),
        launch_nonce: SUPERVISOR_NONCE.to_vec(),
        containment: Some(wire::ContainmentCapabilities::default()),
        ..wire::SupervisorHello::default()
    }
}

pub fn expected_provenance() -> wire::ExpectedRuntimeProvenance {
    wire::ExpectedRuntimeProvenance {
        build_id: "supervisor-build".into(),
        source_commit: "source-commit".into(),
        binary_sha256: vec![1; 32],
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    }
}

pub fn version() -> wire::ProtocolVersion {
    wire::ProtocolVersion { major: 1, minor: 1 }
}

pub fn payload(body: wire::management_payload::Body) -> wire::ManagementPayload {
    wire::ManagementPayload { body: Some(body) }
}

pub fn ack_for(inbound: &PendingManagementInbound) -> wire::ManagementPayload {
    payload(wire::management_payload::Body::ManagementAck(
        wire::ManagementAck {
            acknowledged_message_id: inbound.message_id().into(),
            acknowledged_payload_sha256: inbound.payload_digest().to_vec(),
            acknowledged_at_unix_ms: NOW + 1,
        },
    ))
}

pub fn attempt_identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "executor:test".into(),
        fencing_epoch: 1,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        ..wire::AttemptIdentity::default()
    }
}

pub fn resource_budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 64 * 1024 * 1024,
        hard_memory_bytes: 128 * 1024 * 1024,
        cpu_time_ms: 1_000,
        max_wall_ms: 500,
        max_processes: 2,
        max_threads: 4,
        max_open_handles: 64,
        max_hot_transcript_bytes: 1024,
        max_ipc_frames: 32,
        max_ipc_bytes: 64 * 1024,
        max_spool_bytes: 1024,
        max_artifact_bytes: 1024,
        max_concurrent_tools: 2,
        max_blocking_tasks: 2,
        cancel_grace_ms: 100,
    }
}

pub fn launch_attempt() -> wire::LaunchAttemptProcess {
    wire::LaunchAttemptProcess {
        identity: Some(attempt_identity()),
        resource_budget: Some(resource_budget()),
        hard_deadline_at_unix_ms: NOW + 1_000,
        authority_lease_expires_at_unix_ms: NOW + 900,
        launch_nonce: vec![5; 32],
        protected_endpoints: [
            wire::AttemptEndpointKind::Control,
            wire::AttemptEndpointKind::Data,
            wire::AttemptEndpointKind::RunnerPulse,
        ]
        .into_iter()
        .map(|kind| wire::ProtectedAttemptEndpoint {
            kind: kind as i32,
            endpoint_id: format!("endpoint:{}", kind.as_str_name()),
            address: format!("pipe:{}", kind.as_str_name()),
            connection_token: vec![6; 32],
            max_frame_bytes: match kind {
                wire::AttemptEndpointKind::Control => CONTROL_FRAME_MAX_BYTES as u64,
                wire::AttemptEndpointKind::Data => DATA_FRAME_MAX_BYTES as u64,
                wire::AttemptEndpointKind::RunnerPulse => PULSE_FRAME_MAX_BYTES as u64,
                wire::AttemptEndpointKind::Unspecified => unreachable!("fixture endpoint"),
            },
            connection_id: format!("connection:{}", kind.as_str_name()),
        })
        .collect(),
        expected_runner_provenance: Some(expected_provenance()),
        idempotency_key: "launch:test".into(),
        required_enforced_limits: vec![
            wire::ResourceLimitKind::Memory as i32,
            wire::ResourceLimitKind::WallTime as i32,
            wire::ResourceLimitKind::Processes as i32,
        ],
        activation_authority_seal: Some(wire::ActivationAuthoritySeal {
            agent_run_version: 8,
            attempt_version: 5,
            activation_nonce_sha256: vec![7; 32],
        }),
    }
}

pub fn launch_accepted() -> wire::LaunchAccepted {
    let launch = launch_attempt();
    wire::LaunchAccepted {
        identity: launch.identity,
        reservation_id: "reservation:test".into(),
        reserved_budget: launch.resource_budget,
        hard_deadline_at_unix_ms: launch.hard_deadline_at_unix_ms,
        accepted_at_unix_ms: NOW + 2,
    }
}

pub fn update_authority() -> wire::UpdateAttemptAuthority {
    wire::UpdateAttemptAuthority {
        identity: Some(attempt_identity()),
        authority_lease_expires_at_unix_ms: NOW + 900,
        hard_deadline_at_unix_ms: NOW + 1_000,
        updated_at_unix_ms: NOW + 2,
        idempotency_key: "update:test".into(),
    }
}
