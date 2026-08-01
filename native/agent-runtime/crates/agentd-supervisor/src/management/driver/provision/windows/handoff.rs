use agent_protocol::generated::v1 as wire;
use agent_protocol::runner_bootstrap::RUNNER_BOOTSTRAP_SCHEMA_VERSION;

use super::super::{ProtectedLaunchHandoffFacts, ProtectedLaunchPhysicalFacts};

pub(super) fn build_windows_handoff(
    facts: &ProtectedLaunchHandoffFacts,
    physical: &ProtectedLaunchPhysicalFacts,
) -> wire::RunnerLaunchHandoff {
    wire::RunnerLaunchHandoff {
        schema_version: RUNNER_BOOTSTRAP_SCHEMA_VERSION,
        identity: Some(facts.identity().clone()),
        runtime_instance_id: facts.runtime_instance_id().into(),
        runner_process_id: physical.process_id(),
        endpoints: facts.endpoints().iter().map(endpoint).collect(),
        launch_nonce: facts.launch_nonce().to_vec(),
        hard_deadline_at_unix_ms: facts.hard_deadline_at_unix_ms(),
        reserved_resource_budget: Some(facts.reserved_resource_budget()),
        effective_containment: Some(physical.effective_containment_wire()),
        launch_management_payload_sha256: facts.launch_management_payload_sha256().to_vec(),
        expected_host_peer: Some(facts.peer_authority().expected_host_peer()),
        expected_supervisor_peer: Some(facts.peer_authority().expected_supervisor_peer()),
        activation_authority_seal: Some(facts.activation_authority_seal().clone()),
        runtime_provenance: Some(facts.runtime_provenance(physical.process_id())),
        runner_pulse_interval_ms: facts.runner_pulse_interval_ms(),
    }
}

fn endpoint(value: &wire::ProtectedAttemptEndpoint) -> wire::RunnerLaunchEndpoint {
    let kind = wire::AttemptEndpointKind::try_from(value.kind)
        .unwrap_or(wire::AttemptEndpointKind::Unspecified);
    wire::RunnerLaunchEndpoint {
        kind: value.kind,
        endpoint_id: value.endpoint_id.clone(),
        address: value.address.clone(),
        connection_id: value.connection_id.clone(),
        connection_token: value.connection_token.clone(),
        max_frame_bytes: value.max_frame_bytes,
        provisioning: wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32,
        listener_slot: wire::RunnerListenerSlot::Unspecified as i32,
        expected_peer_role: expected_peer_role(kind) as i32,
    }
}

const fn expected_peer_role(kind: wire::AttemptEndpointKind) -> wire::RunnerExpectedPeerRole {
    match kind {
        wire::AttemptEndpointKind::Control | wire::AttemptEndpointKind::Data => {
            wire::RunnerExpectedPeerRole::Host
        }
        wire::AttemptEndpointKind::RunnerPulse => wire::RunnerExpectedPeerRole::Supervisor,
        wire::AttemptEndpointKind::Unspecified => wire::RunnerExpectedPeerRole::Unspecified,
    }
}
