use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::{PendingRunnerLaunchNonce, decode_runner_launch_handoff};
use prost::Message;

use super::{
    CONNECTION_ID, LAUNCH_DEADLINE, LAUNCH_NONCE, RUNTIME_ID, activation_authority_seal,
    agent_hello, resource_budget, wire_identity,
};

pub(in crate::control::tests) fn agent_hello_draft() -> wire::AgentHello {
    let mut draft = agent_hello();
    draft.launch_nonce.clear();
    draft
}

pub(in crate::control::tests) fn launch_nonce_authority() -> PendingRunnerLaunchNonce {
    let mut handoff = decode_runner_launch_handoff(test_handoff().encode_to_vec())
        .expect("shape-valid launch authority");
    handoff
        .take_launch_nonce()
        .expect("single-use launch nonce")
}

fn test_handoff() -> wire::RunnerLaunchHandoff {
    wire::RunnerLaunchHandoff {
        schema_version: 1,
        identity: Some(wire_identity()),
        runtime_instance_id: RUNTIME_ID.into(),
        runner_process_id: 42,
        endpoints: endpoints(),
        launch_nonce: LAUNCH_NONCE.to_vec(),
        hard_deadline_at_unix_ms: LAUNCH_DEADLINE,
        reserved_resource_budget: Some(resource_budget()),
        effective_containment: Some(containment()),
        launch_management_payload_sha256: vec![8; 32],
        expected_host_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: 1,
            unix_user_id: None,
        }),
        expected_supervisor_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: 2,
            unix_user_id: None,
        }),
        activation_authority_seal: Some(activation_authority_seal()),
        runtime_provenance: Some(agent_hello().provenance.expect("fixture provenance")),
    }
}

fn endpoints() -> Vec<wire::RunnerLaunchEndpoint> {
    [
        (
            wire::AttemptEndpointKind::Control,
            "control",
            CONNECTION_ID,
            CONTROL_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            9_u8,
        ),
        (
            wire::AttemptEndpointKind::Data,
            "data",
            "connection-data",
            DATA_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Host,
            10_u8,
        ),
        (
            wire::AttemptEndpointKind::RunnerPulse,
            "pulse",
            "connection-pulse",
            PULSE_FRAME_MAX_BYTES,
            wire::RunnerExpectedPeerRole::Supervisor,
            11_u8,
        ),
    ]
    .into_iter()
    .map(
        |(kind, name, connection, maximum, role, token)| wire::RunnerLaunchEndpoint {
            kind: kind as i32,
            endpoint_id: format!("endpoint-{name}"),
            address: format!(r"\\.\pipe\codestudio-agent-v1-{name}-00000001-0000000000000001"),
            connection_id: connection.into(),
            connection_token: vec![token; 32],
            max_frame_bytes: maximum as u64,
            provisioning: wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32,
            listener_slot: wire::RunnerListenerSlot::Unspecified as i32,
            expected_peer_role: role as i32,
        },
    )
    .collect()
}

fn containment() -> wire::ContainmentReport {
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
        capabilities: Some(wire::ContainmentCapabilities {
            process_tree: true,
            memory_limit: true,
            cpu_limit: true,
            process_count_limit: true,
            ..Default::default()
        }),
    }
}
