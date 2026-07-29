use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_channel::ManagementDeadlinePolicy;
use agent_protocol::management_frame::MANAGEMENT_FRAME_MAX_BYTES;

use crate::management::SupervisorLaunchReceipt;

use super::{CONNECTION, NONCE, TOKEN};

pub(in crate::management::tests) fn host_hello() -> wire::HostSupervisorHello {
    wire::HostSupervisorHello {
        selected_protocol: Some(version()),
        connection_id: CONNECTION.into(),
        contract_version: "contract:test".into(),
        contract_schema_version: 1,
        expected_supervisor_provenance: Some(expected_provenance()),
        allowed_runner_provenance: vec![expected_provenance()],
        limits: Some(wire::SupervisorLimits {
            max_active_attempts: 4,
            max_pending_launches: 4,
            max_reserved_memory_bytes: 1024 * 1024,
            max_reserved_processes: 8,
            host_disconnect_grace_ms: 1_000,
            runner_pulse_timeout_ms: 500,
        }),
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: MANAGEMENT_FRAME_MAX_BYTES as u64,
            max_chunk_bytes: 16 * 1024,
            max_in_flight_frames: 8,
            max_in_flight_bytes: 512 * 1024,
            read_timeout_ms: 1_000,
            write_timeout_ms: 1_000,
            transport_crc32c: false,
        }),
        management_session_token: TOKEN.to_vec(),
        required_containment_level: wire::ContainmentLevel::Monitored as i32,
        allowed_feature_bits: 0,
    }
}

pub(in crate::management::tests) fn launch_receipt() -> SupervisorLaunchReceipt {
    SupervisorLaunchReceipt::new(
        wire::ProtocolVersionRange {
            minimum: Some(version()),
            maximum: Some(version()),
        },
        "supervisor-build".into(),
        "commit".into(),
        vec![1; 32],
        "runtime:one".into(),
        "windows".into(),
        "x86_64".into(),
        wire::ContainmentCapabilities::default(),
        0,
        NONCE.to_vec(),
    )
    .expect("launch receipt")
}

fn expected_provenance() -> wire::ExpectedRuntimeProvenance {
    wire::ExpectedRuntimeProvenance {
        build_id: "supervisor-build".into(),
        source_commit: "commit".into(),
        binary_sha256: vec![1; 32],
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    }
}

fn attempt_identity() -> wire::AttemptIdentity {
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

fn resource_budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 256 * 1024,
        hard_memory_bytes: 512 * 1024,
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

pub(in crate::management::tests) fn launch_attempt() -> wire::LaunchAttemptProcess {
    wire::LaunchAttemptProcess {
        identity: Some(attempt_identity()),
        resource_budget: Some(resource_budget()),
        hard_deadline_at_unix_ms: 4_102_444_800_000,
        authority_lease_expires_at_unix_ms: 4_102_444_700_000,
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
        activation_authority_seal: Some(activation_authority_seal()),
    }
}

fn activation_authority_seal() -> wire::ActivationAuthoritySeal {
    wire::ActivationAuthoritySeal {
        agent_run_version: 8,
        attempt_version: 5,
        activation_nonce_sha256: vec![7; 32],
    }
}

pub(in crate::management::tests) fn launch_accepted(
    launch: &wire::LaunchAttemptProcess,
) -> wire::LaunchAccepted {
    wire::LaunchAccepted {
        identity: launch.identity.clone(),
        reservation_id: "reservation:test".into(),
        reserved_budget: launch.resource_budget,
        hard_deadline_at_unix_ms: launch.hard_deadline_at_unix_ms,
        accepted_at_unix_ms: 1_700_000_000_000,
    }
}

pub(in crate::management::tests) fn deadline() -> ManagementDeadlinePolicy {
    ManagementDeadlinePolicy::new(250).expect("deadline")
}

pub(in crate::management::tests) fn version() -> wire::ProtocolVersion {
    wire::ProtocolVersion { major: 1, minor: 1 }
}
