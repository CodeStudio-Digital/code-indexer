use crate::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use crate::generated::v1 as wire;

pub(super) fn windows_handoff() -> wire::RunnerLaunchHandoff {
    wire::RunnerLaunchHandoff {
        schema_version: 1,
        identity: Some(identity()),
        runtime_instance_id: "runtime:opaque/7".into(),
        runner_process_id: 303,
        endpoints: endpoints(wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe),
        launch_nonce: (1_u8..=32).collect(),
        hard_deadline_at_unix_ms: 1_784_894_460_123,
        reserved_resource_budget: Some(budget()),
        effective_containment: Some(containment()),
        launch_management_payload_sha256: (32_u8..=63).collect(),
        expected_host_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: 101,
            unix_user_id: None,
        }),
        expected_supervisor_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: 202,
            unix_user_id: None,
        }),
        activation_authority_seal: Some(activation_authority_seal()),
        runtime_provenance: Some(runtime_provenance()),
        runner_pulse_interval_ms: 100,
    }
}

pub(super) fn unix_handoff() -> wire::RunnerLaunchHandoff {
    let mut value = windows_handoff();
    value
        .expected_host_peer
        .as_mut()
        .expect("host")
        .unix_user_id = Some(1_000);
    value
        .expected_supervisor_peer
        .as_mut()
        .expect("supervisor")
        .unix_user_id = Some(1_000);
    for (endpoint, slot) in value.endpoints.iter_mut().zip([
        wire::RunnerListenerSlot::Control,
        wire::RunnerListenerSlot::Data,
        wire::RunnerListenerSlot::RunnerPulse,
    ]) {
        endpoint.provisioning = wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket as i32;
        endpoint.listener_slot = slot as i32;
        endpoint.address = format!("/run/codestudio/{}.sock", endpoint.endpoint_id);
    }
    value
}

fn endpoints(mode: wire::RunnerEndpointProvisioning) -> Vec<wire::RunnerLaunchEndpoint> {
    [
        (
            wire::AttemptEndpointKind::Control,
            "control",
            CONTROL_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            0x11,
        ),
        (
            wire::AttemptEndpointKind::Data,
            "data",
            DATA_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            0x22,
        ),
        (
            wire::AttemptEndpointKind::RunnerPulse,
            "pulse",
            PULSE_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Supervisor,
            0x33,
        ),
    ]
    .into_iter()
    .map(
        |(kind, name, cap, role, token)| wire::RunnerLaunchEndpoint {
            kind: kind as i32,
            endpoint_id: format!("endpoint:{name}"),
            address: format!(r"\\.\pipe\{name}-7"),
            connection_id: format!("connection:{name}/7"),
            connection_token: vec![token; 16],
            max_frame_bytes: cap as u64,
            provisioning: mode as i32,
            listener_slot: wire::RunnerListenerSlot::Unspecified as i32,
            expected_peer_role: role as i32,
        },
    )
    .collect()
}

fn identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "host:desktop".into(),
        fencing_epoch: 9_007_199_254_740_993,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        owner_agent_run_id: Some("77777777-7777-4777-8777-777777777777".into()),
        parent_agent_run_id: None,
    }
}

fn activation_authority_seal() -> wire::ActivationAuthoritySeal {
    wire::ActivationAuthoritySeal {
        agent_run_version: 8,
        attempt_version: 5,
        activation_nonce_sha256: vec![7; 32],
    }
}

fn runtime_provenance() -> wire::RuntimeProvenance {
    wire::RuntimeProvenance {
        build_id: "runner-build".into(),
        source_commit: "runner-commit".into(),
        binary_sha256: vec![8; 32],
        runtime_instance_id: "runtime:opaque/7".into(),
        pid: 303,
        operating_system: "windows".into(),
        architecture: "x86_64".into(),
    }
}

fn budget() -> wire::ResourceBudget {
    wire::ResourceBudget {
        soft_memory_bytes: 268_435_456,
        hard_memory_bytes: 536_870_912,
        cpu_time_ms: 120_000,
        max_wall_ms: 180_000,
        max_processes: 8,
        max_threads: 32,
        max_open_handles: 512,
        max_hot_transcript_bytes: 4_194_304,
        max_ipc_frames: 128,
        max_ipc_bytes: 8_388_608,
        max_spool_bytes: 67_108_864,
        max_artifact_bytes: 16_777_216,
        max_concurrent_tools: 4,
        max_blocking_tasks: 4,
        cancel_grace_ms: 5_000,
    }
}

fn containment() -> wire::ContainmentReport {
    wire::ContainmentReport {
        level: wire::ContainmentLevel::HardAggregate as i32,
        enforced_limits: vec![
            wire::ResourceLimitKind::Memory as i32,
            wire::ResourceLimitKind::CpuTime as i32,
            wire::ResourceLimitKind::WallTime as i32,
            wire::ResourceLimitKind::Processes as i32,
        ],
        unsupported_limits: vec![
            wire::ResourceLimitKind::Threads as i32,
            wire::ResourceLimitKind::OpenHandles as i32,
            wire::ResourceLimitKind::ScratchBytes as i32,
        ],
        capabilities: Some(wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            ..Default::default()
        }),
    }
}
