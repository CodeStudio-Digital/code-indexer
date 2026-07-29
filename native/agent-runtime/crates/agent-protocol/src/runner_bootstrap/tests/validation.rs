use crate::generated::v1 as wire;

use super::super::{RunnerBootstrapError, prepare_runner_launch_handoff};
use super::support::{unix_handoff, windows_handoff};

fn assert_invalid(mutator: impl FnOnce(&mut wire::RunnerLaunchHandoff)) {
    let mut handoff = windows_handoff();
    mutator(&mut handoff);
    assert!(matches!(
        prepare_runner_launch_handoff(handoff),
        Err(RunnerBootstrapError::InvalidField { .. } | RunnerBootstrapError::InvalidIdentity(_))
    ));
}

#[test]
fn authority_and_secret_material_are_strictly_validated() {
    assert_invalid(|value| value.schema_version = 2);
    assert_invalid(|value| value.identity.as_mut().expect("identity").fencing_epoch = 0);
    assert_invalid(|value| value.runtime_instance_id.clear());
    assert_invalid(|value| value.runner_process_id = 0);
    assert_invalid(|value| value.hard_deadline_at_unix_ms = 0);
    assert_invalid(|value| value.launch_nonce.truncate(15));
    assert_invalid(|value| value.launch_management_payload_sha256.truncate(31));
    assert_invalid(|value| value.activation_authority_seal = None);
    assert_invalid(|value| value.runtime_provenance = None);
    assert_invalid(|value| {
        value
            .runtime_provenance
            .as_mut()
            .expect("runtime provenance")
            .runtime_instance_id = "runtime:foreign".into();
    });
    assert_invalid(|value| {
        value
            .runtime_provenance
            .as_mut()
            .expect("runtime provenance")
            .pid += 1;
    });
    assert_invalid(|value| {
        value
            .runtime_provenance
            .as_mut()
            .expect("runtime provenance")
            .binary_sha256
            .truncate(31);
    });
    assert_invalid(|value| {
        value
            .activation_authority_seal
            .as_mut()
            .expect("activation seal")
            .agent_run_version = 0;
    });
    assert_invalid(|value| {
        value
            .activation_authority_seal
            .as_mut()
            .expect("activation seal")
            .attempt_version = 0;
    });
    assert_invalid(|value| {
        value
            .activation_authority_seal
            .as_mut()
            .expect("activation seal")
            .activation_nonce_sha256
            .truncate(31);
    });
    assert_invalid(|value| value.endpoints[0].connection_token.truncate(15));
    assert_invalid(|value| value.launch_nonce = vec![7; 257]);
    assert_invalid(|value| value.endpoints[0].connection_token = vec![7; 513]);

    let mut maximums = windows_handoff();
    maximums.launch_nonce = vec![7; 256];
    maximums.endpoints[0].connection_token = vec![7; 512];
    assert!(prepare_runner_launch_handoff(maximums).is_ok());
}

#[test]
fn endpoints_are_exactly_canonical_unique_and_bounded() {
    assert_invalid(|value| {
        value.endpoints.pop();
    });
    assert_invalid(|value| value.endpoints.swap(0, 1));
    assert_invalid(|value| value.endpoints[1].endpoint_id = value.endpoints[0].endpoint_id.clone());
    assert_invalid(|value| {
        value.endpoints[1].connection_id = value.endpoints[0].connection_id.clone();
    });
    assert_invalid(|value| {
        value.endpoints[1].connection_token = value.endpoints[0].connection_token.clone();
    });
    assert_invalid(|value| value.endpoints[0].max_frame_bytes += 1);
    assert_invalid(|value| {
        value.endpoints[2].expected_peer_role = wire::RunnerExpectedPeerRole::Host as i32;
    });
}

#[test]
fn provisioning_mode_peer_identity_and_slots_cannot_be_mixed() {
    assert_invalid(|value| {
        value.endpoints[1].provisioning =
            wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket as i32;
    });
    assert_invalid(|value| {
        value.endpoints[0].listener_slot = wire::RunnerListenerSlot::Control as i32;
    });
    assert_invalid(|value| {
        value
            .expected_host_peer
            .as_mut()
            .expect("host")
            .unix_user_id = Some(1_000);
    });
    assert_invalid(|value| {
        value
            .expected_supervisor_peer
            .as_mut()
            .expect("peer")
            .process_id = 101;
    });
    assert_invalid(|value| {
        value.expected_host_peer.as_mut().expect("peer").process_id = 303;
    });

    let mut unix = unix_handoff();
    unix.endpoints[2].listener_slot = wire::RunnerListenerSlot::Data as i32;
    assert!(prepare_runner_launch_handoff(unix).is_err());
}

#[test]
fn budget_and_containment_must_be_complete_and_consistent() {
    assert_invalid(|value| {
        value
            .reserved_resource_budget
            .as_mut()
            .expect("budget")
            .hard_memory_bytes = 0;
    });
    assert_invalid(|value| {
        let budget = value.reserved_resource_budget.as_mut().expect("budget");
        budget.max_artifact_bytes = budget.max_spool_bytes + 1;
    });
    assert_invalid(|value| {
        value
            .effective_containment
            .as_mut()
            .expect("containment")
            .unsupported_limits
            .pop();
    });
    assert_invalid(|value| {
        value
            .effective_containment
            .as_mut()
            .expect("containment")
            .capabilities
            .as_mut()
            .expect("capabilities")
            .memory_limit = false;
    });
    assert_invalid(|value| {
        value
            .effective_containment
            .as_mut()
            .expect("containment")
            .level = wire::ContainmentLevel::Unavailable as i32;
    });
}
