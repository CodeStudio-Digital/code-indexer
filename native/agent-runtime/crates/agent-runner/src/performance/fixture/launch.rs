use agent_protocol::activation_authority::activation_nonce_sha256;
use agent_protocol::frame::{CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, PULSE_FRAME_MAX_BYTES};
use agent_protocol::generated::v1 as wire;

use super::{
    ACTIVATION_NONCE, CONNECTION_ID, LAUNCH_NONCE, RUNTIME_ID, agent_hello_draft,
    containment_report, identity, resource_budget,
};

pub(super) fn launch_handoff(deadline_at_unix_ms: i64) -> wire::RunnerLaunchHandoff {
    let runner_process_id = std::process::id();
    let (host_process_id, supervisor_process_id) = peer_process_ids(runner_process_id);
    let unix_user_id = cfg!(unix).then_some(1);
    wire::RunnerLaunchHandoff {
        schema_version: 1,
        identity: Some(identity()),
        runtime_instance_id: RUNTIME_ID.into(),
        runner_process_id,
        endpoints: endpoints(),
        launch_nonce: LAUNCH_NONCE.to_vec(),
        hard_deadline_at_unix_ms: deadline_at_unix_ms,
        reserved_resource_budget: Some(resource_budget()),
        effective_containment: Some(containment_report()),
        launch_management_payload_sha256: vec![8; 32],
        expected_host_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: host_process_id,
            unix_user_id,
        }),
        expected_supervisor_peer: Some(wire::RunnerExpectedLocalPeer {
            process_id: supervisor_process_id,
            unix_user_id,
        }),
        activation_authority_seal: Some(wire::ActivationAuthoritySeal {
            agent_run_version: 8,
            attempt_version: 5,
            activation_nonce_sha256: activation_nonce_sha256(ACTIVATION_NONCE).to_vec(),
        }),
        runtime_provenance: agent_hello_draft().provenance,
    }
}

fn endpoints() -> Vec<wire::RunnerLaunchEndpoint> {
    [
        (
            wire::AttemptEndpointKind::Control,
            CONTROL_FRAME_MAX_BYTES,
            9,
        ),
        (wire::AttemptEndpointKind::Data, DATA_FRAME_MAX_BYTES, 10),
        (
            wire::AttemptEndpointKind::RunnerPulse,
            PULSE_FRAME_MAX_BYTES,
            11,
        ),
    ]
    .into_iter()
    .map(|(kind, maximum, token)| endpoint(kind, maximum, token))
    .collect()
}

fn endpoint(
    kind: wire::AttemptEndpointKind,
    maximum: usize,
    token: u8,
) -> wire::RunnerLaunchEndpoint {
    let label = kind.as_str_name().to_ascii_lowercase();
    wire::RunnerLaunchEndpoint {
        kind: kind as i32,
        endpoint_id: format!("perf-{label}"),
        address: format!("perf://{label}"),
        connection_id: if kind == wire::AttemptEndpointKind::Control {
            CONNECTION_ID.into()
        } else {
            format!("perf-{label}-connection")
        },
        connection_token: vec![token; 32],
        max_frame_bytes: u64::try_from(maximum).unwrap_or(u64::MAX),
        provisioning: provisioning() as i32,
        listener_slot: listener_slot(kind) as i32,
        expected_peer_role: if kind == wire::AttemptEndpointKind::RunnerPulse {
            wire::RunnerExpectedPeerRole::Supervisor as i32
        } else {
            wire::RunnerExpectedPeerRole::Host as i32
        },
    }
}

const fn provisioning() -> wire::RunnerEndpointProvisioning {
    if cfg!(windows) {
        wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe
    } else {
        wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket
    }
}

const fn listener_slot(kind: wire::AttemptEndpointKind) -> wire::RunnerListenerSlot {
    if cfg!(windows) {
        wire::RunnerListenerSlot::Unspecified
    } else {
        match kind {
            wire::AttemptEndpointKind::Control => wire::RunnerListenerSlot::Control,
            wire::AttemptEndpointKind::Data => wire::RunnerListenerSlot::Data,
            wire::AttemptEndpointKind::RunnerPulse => wire::RunnerListenerSlot::RunnerPulse,
            wire::AttemptEndpointKind::Unspecified => wire::RunnerListenerSlot::Unspecified,
        }
    }
}

const fn peer_process_ids(runner: u32) -> (u32, u32) {
    let host = if runner == 1 { 2 } else { 1 };
    let supervisor = if runner == 3 || host == 3 { 4 } else { 3 };
    (host, supervisor)
}
