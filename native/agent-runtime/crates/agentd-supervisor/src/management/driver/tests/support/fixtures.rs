use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::MANAGEMENT_FRAME_MAX_BYTES;

use crate::management::SupervisorLaunchReceipt;
use crate::management::driver::config::{
    TrustedRunnerConfig, TrustedRunnerProvenance, absolute_test_path,
};
use crate::management::driver::provision::ProtectedLaunchPeerAuthority;

use super::{CONNECTION, NONCE, TOKEN};

pub(in crate::management::driver::tests) fn trusted_runner() -> TrustedRunnerConfig {
    TrustedRunnerConfig::new(
        absolute_test_path("agent-runner.exe"),
        absolute_test_path("runner-work"),
        Vec::new(),
        TrustedRunnerProvenance::new(
            "runner-build".into(),
            "runner-commit".into(),
            [8; 32],
            "windows".into(),
            "x86_64".into(),
        )
        .expect("runner provenance"),
    )
    .expect("trusted runner")
}

pub(in crate::management::driver::tests) fn peer_authority() -> ProtectedLaunchPeerAuthority {
    let supervisor_process_id = std::process::id();
    let host_process_id = (1..=u32::MAX)
        .find(|candidate| *candidate != supervisor_process_id && *candidate != 41)
        .expect("two excluded process IDs leave a valid host PID");
    #[cfg(windows)]
    let unix_ids = (None, None);
    #[cfg(unix)]
    let unix_ids = (Some(1_000), Some(1_000));
    ProtectedLaunchPeerAuthority::new_for_test(
        host_process_id,
        supervisor_process_id,
        unix_ids.0,
        unix_ids.1,
    )
    .expect("valid test peer authority")
}

pub(in crate::management::driver::tests) fn host_hello_with_maximum_in_flight(
    maximum_in_flight_frames: u64,
) -> wire::HostSupervisorHello {
    wire::HostSupervisorHello {
        selected_protocol: Some(version()),
        connection_id: CONNECTION.into(),
        contract_version: "contract:test".into(),
        contract_schema_version: 1,
        expected_supervisor_provenance: Some(expected_supervisor()),
        allowed_runner_provenance: vec![expected_runner()],
        limits: Some(wire::SupervisorLimits {
            max_active_attempts: 4,
            max_pending_launches: 4,
            max_reserved_memory_bytes: 1024 * 1024 * 1024,
            max_reserved_processes: 16,
            host_disconnect_grace_ms: 1_000,
            runner_pulse_timeout_ms: 500,
        }),
        frame_limits: Some(wire::FrameLimits {
            max_frame_bytes: MANAGEMENT_FRAME_MAX_BYTES as u64,
            max_chunk_bytes: 16 * 1024,
            max_in_flight_frames: maximum_in_flight_frames,
            max_in_flight_bytes: 512 * 1024,
            read_timeout_ms: 1_000,
            write_timeout_ms: 1_000,
            transport_crc32c: false,
        }),
        management_session_token: TOKEN.to_vec(),
        required_containment_level: wire::ContainmentLevel::HardAggregate as i32,
        allowed_feature_bits: 0,
    }
}

pub(in crate::management::driver::tests) fn launch_attempt() -> wire::LaunchAttemptProcess {
    wire::LaunchAttemptProcess {
        identity: Some(identity()),
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
            max_frame_bytes: endpoint_cap(kind) as u64,
            connection_id: format!("connection:{}", kind.as_str_name()),
        })
        .collect(),
        expected_runner_provenance: Some(expected_runner()),
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

pub(super) fn launch_receipt() -> SupervisorLaunchReceipt {
    SupervisorLaunchReceipt::new(
        wire::ProtocolVersionRange {
            minimum: Some(version()),
            maximum: Some(version()),
        },
        "supervisor-build".into(),
        "supervisor-commit".into(),
        vec![1; 32],
        "supervisor:runtime".into(),
        "windows".into(),
        "x86_64".into(),
        wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            ..wire::ContainmentCapabilities::default()
        },
        0,
        NONCE.to_vec(),
    )
    .expect("launch receipt")
}

fn endpoint_cap(kind: wire::AttemptEndpointKind) -> usize {
    match kind {
        wire::AttemptEndpointKind::Control => CONTROL_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::Data => DATA_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::RunnerPulse => PULSE_FRAME_MAX_BYTES,
        wire::AttemptEndpointKind::Unspecified => unreachable!("fixture endpoint"),
    }
}

fn expected_supervisor() -> wire::ExpectedRuntimeProvenance {
    wire::ExpectedRuntimeProvenance {
        build_id: "supervisor-build".into(),
        source_commit: "supervisor-commit".into(),
        binary_sha256: vec![1; 32],
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    }
}

fn expected_runner() -> wire::ExpectedRuntimeProvenance {
    wire::ExpectedRuntimeProvenance {
        build_id: "runner-build".into(),
        source_commit: "runner-commit".into(),
        binary_sha256: vec![8; 32],
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    }
}

fn identity() -> wire::AttemptIdentity {
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
        max_hot_transcript_bytes: 1_024,
        max_ipc_frames: 32,
        max_ipc_bytes: 64 * 1_024,
        max_spool_bytes: 1_024,
        max_artifact_bytes: 1_024,
        max_concurrent_tools: 2,
        max_blocking_tasks: 2,
        cancel_grace_ms: 100,
    }
}

const fn version() -> wire::ProtocolVersion {
    wire::ProtocolVersion { major: 1, minor: 1 }
}
