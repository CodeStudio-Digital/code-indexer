use std::fmt::Write as _;
use std::sync::atomic::Ordering;

use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::validate_management_frame;

use super::super::{
    FailClosedProtectedLaunchProvisioner, ProtectedLaunchPeerAuthority, SupervisorDriverStep,
    SupervisorPhysicalDriver,
};
use super::fakes::{FakeContainment, FakeProvisioner};
use super::support::{
    TestWriter, ack_frame_for_output, decoded_bodies, established, established_appendable,
    launch_attempt, launch_frame, peer_authority, trusted_runner,
};

#[test]
fn production_provisioner_rejects_before_any_spawn() {
    let writer = TestWriter::default();
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
    );
    let (containment, state) = FakeContainment::healthy();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        FailClosedProtectedLaunchProvisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("typed rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 0);
    assert_eq!(driver.owned_attempts(), 0);
    assert!(driver.state().is_accepting_launches());
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));
}

#[test]
fn typed_receipts_emit_complete_facts_without_secrets_in_argv_or_env() {
    let writer = TestWriter::default();
    let launch = launch_attempt();
    let launch_frame = launch_frame(launch.clone(), "launch", 2);
    let payload_digest = payload_digest(&launch_frame);
    let (channel, reader) = established_appendable(vec![launch_frame], writer.clone(), 1);
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let prepare_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let observed_secret_bytes = provisioner.observed_secret_bytes.clone();
    let observed_process_id = provisioner.observed_process_id.clone();
    let observed_authority_lease = provisioner
        .observed_authority_lease_expires_at_unix_ms
        .clone();
    let observed_handoff = provisioner.observed_handoff.clone();
    let authority = peer_authority();
    let expected_host_peer = authority.expected_host_peer();
    let expected_supervisor_peer = authority.expected_supervisor_peer();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        authority,
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("launch"),
        SupervisorDriverStep::LaunchAccepted {
            reused_existing: false
        }
    );
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(observed_process_id.load(Ordering::SeqCst), 41);
    assert_eq!(
        observed_authority_lease.load(Ordering::SeqCst),
        launch.authority_lease_expires_at_unix_ms
    );
    assert_eq!(
        *state
            .child_handle_counts
            .lock()
            .expect("child handle counts"),
        vec![1]
    );
    assert_eq!(driver.owned_attempts(), 1);
    assert!(observed_secret_bytes.load(Ordering::SeqCst) > 0);
    let handoff = observed_handoff
        .lock()
        .expect("observed handoff")
        .clone()
        .expect("completed handoff");
    assert_complete_handoff(
        &handoff,
        &launch,
        &payload_digest,
        expected_host_peer,
        expected_supervisor_peer,
    );

    for (index, message_id, sequence) in [
        (1, "ack:accepted", 3),
        (2, "ack:spawned", 4),
        (3, "ack:containment", 5),
    ] {
        reader.append_frame(ack_frame_for_output(&writer, index, message_id, sequence));
        assert_eq!(
            driver.process_next().expect("fact ack"),
            SupervisorDriverStep::ManagementAcknowledged
        );
    }

    let launched = state
        .last_launch
        .lock()
        .expect("last launch")
        .clone()
        .expect("contained launch");
    assert!(launched.arguments.is_empty());
    assert!(launched.environment.is_empty());
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchAccepted(_),
            wire::management_payload::Body::AttemptProcessSpawned(_),
            wire::management_payload::Body::AttemptContainmentReport(_)
        ]
    ));
}

#[test]
fn completion_failure_reaps_only_the_spawned_attempt_and_never_accepts_it() {
    let writer = TestWriter::default();
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::failing_completion();
    let prepare_calls = provisioner.calls.clone();
    let complete_calls = provisioner.complete_calls.clone();
    let observed_process_id = provisioner.observed_process_id.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("completion rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(prepare_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(observed_process_id.load(Ordering::SeqCst), 41);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert!(driver.state().is_accepting_launches());
    assert_eq!(driver.owned_attempts(), 1);
    assert!(driver.reserved_memory_bytes() > 0);
    assert_eq!(
        driver.launch_registry.state_for_test("launch:test"),
        Some((1, false, true, false, false))
    );
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));
}

#[test]
fn receipt_seals_the_full_endpoint_map_before_launch_acceptance() {
    let writer = TestWriter::default();
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::mismatched_receipt();
    let complete_calls = provisioner.complete_calls.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("receipt mismatch rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert!(driver.state().is_accepting_launches());
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));
}

#[test]
fn receipt_cannot_replace_the_physical_peer_authority() {
    let writer = TestWriter::default();
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::mismatched_peer_receipt();
    let complete_calls = provisioner.complete_calls.clone();
    let observed_handoff = provisioner.observed_handoff.clone();
    let authority = peer_authority();
    let expected_host_peer = authority.expected_host_peer();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        authority,
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("peer receipt rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    let divergent = observed_handoff
        .lock()
        .expect("observed handoff")
        .clone()
        .expect("divergent handoff");
    assert_ne!(divergent.expected_host_peer, Some(expected_host_peer));
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert!(driver.state().is_accepting_launches());
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));
}

#[test]
fn receipt_cannot_replace_the_authority_lease() {
    let writer = TestWriter::default();
    let launch = launch_attempt();
    let expected_authority_lease = launch.authority_lease_expires_at_unix_ms;
    let channel = established(vec![launch_frame(launch, "launch", 2)], writer.clone());
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::mismatched_lease_receipt();
    let complete_calls = provisioner.complete_calls.clone();
    let observed_authority_lease = provisioner
        .observed_authority_lease_expires_at_unix_ms
        .clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority(),
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("lease receipt rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(
        observed_authority_lease.load(Ordering::SeqCst),
        expected_authority_lease.saturating_sub(1)
    );
    assert_eq!(complete_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert!(driver.state().is_accepting_launches());
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));
}

#[test]
fn runner_process_cannot_alias_an_expected_peer() {
    let writer = TestWriter::default();
    let channel = established(
        vec![launch_frame(launch_attempt(), "launch", 2)],
        writer.clone(),
    );
    let (containment, state) = FakeContainment::healthy();
    let provisioner = FakeProvisioner::successful();
    let complete_calls = provisioner.complete_calls.clone();
    let observed_handoff = provisioner.observed_handoff.clone();
    let mut driver = SupervisorPhysicalDriver::new(
        channel,
        containment,
        provisioner,
        trusted_runner(),
        peer_authority_colliding_with_runner(),
    )
    .expect("driver");

    assert_eq!(
        driver.process_next().expect("peer collision rejection"),
        SupervisorDriverStep::LaunchRejected {
            reason_code: "SUPERVISOR_PROTECTED_HANDOFF_UNAVAILABLE"
        }
    );
    assert_eq!(state.spawn_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.terminate_calls.load(Ordering::SeqCst), 1);
    assert_eq!(complete_calls.load(Ordering::SeqCst), 0);
    assert!(observed_handoff.lock().expect("observed handoff").is_none());
    assert!(driver.state().is_accepting_launches());
    assert!(matches!(
        decoded_bodies(&writer).as_slice(),
        [
            wire::management_payload::Body::SupervisorHello(_),
            wire::management_payload::Body::LaunchRejected(_)
        ]
    ));
}

fn payload_digest(frame: &[u8]) -> [u8; 32] {
    let validated = validate_management_frame(frame).expect("valid launch frame");
    validated
        .frame
        .header
        .as_ref()
        .expect("launch frame header")
        .payload_sha256
        .as_slice()
        .try_into()
        .expect("validated digest length")
}

fn peer_authority_colliding_with_runner() -> ProtectedLaunchPeerAuthority {
    const RUNNER_PROCESS_ID: u32 = 41;
    let supervisor_process_id = std::process::id();
    let host_process_id = if supervisor_process_id == RUNNER_PROCESS_ID {
        42
    } else {
        RUNNER_PROCESS_ID
    };
    #[cfg(windows)]
    let unix_user_ids = (None, None);
    #[cfg(unix)]
    let unix_user_ids = (Some(1_000), Some(1_000));
    ProtectedLaunchPeerAuthority::new_for_test(
        host_process_id,
        supervisor_process_id,
        unix_user_ids.0,
        unix_user_ids.1,
    )
    .expect("valid explicit peer authority")
}

fn runtime_instance_id(payload_digest: &[u8; 32]) -> String {
    let mut value = String::from("runtime:");
    for byte in payload_digest.iter().take(16) {
        write!(&mut value, "{byte:02x}").expect("string formatting");
    }
    value
}

fn assert_complete_handoff(
    handoff: &wire::RunnerLaunchHandoff,
    launch: &wire::LaunchAttemptProcess,
    payload_digest: &[u8; 32],
    expected_host_peer: wire::RunnerExpectedLocalPeer,
    expected_supervisor_peer: wire::RunnerExpectedLocalPeer,
) {
    assert_eq!(handoff.identity, launch.identity);
    assert_eq!(
        handoff.runtime_instance_id,
        runtime_instance_id(payload_digest)
    );
    assert_eq!(handoff.runner_process_id, 41);
    let expected = launch
        .expected_runner_provenance
        .as_ref()
        .expect("expected runner provenance");
    assert_eq!(
        handoff.runtime_provenance,
        Some(wire::RuntimeProvenance {
            build_id: expected.build_id.clone(),
            source_commit: expected.source_commit.clone(),
            binary_sha256: expected.binary_sha256.clone(),
            runtime_instance_id: runtime_instance_id(payload_digest),
            pid: 41,
            operating_system: expected.operating_system.clone(),
            architecture: expected.architecture.clone(),
        })
    );
    assert_eq!(
        handoff.hard_deadline_at_unix_ms,
        launch.hard_deadline_at_unix_ms
    );
    assert_eq!(handoff.reserved_resource_budget, launch.resource_budget);
    assert_eq!(handoff.launch_nonce, launch.launch_nonce);
    assert_eq!(
        handoff.activation_authority_seal,
        launch.activation_authority_seal
    );
    assert_eq!(
        handoff.launch_management_payload_sha256,
        payload_digest.to_vec()
    );
    assert_eq!(handoff.expected_host_peer, Some(expected_host_peer));
    assert_eq!(
        handoff.expected_supervisor_peer,
        Some(expected_supervisor_peer)
    );
    assert_eq!(
        handoff
            .effective_containment
            .as_ref()
            .expect("effective containment")
            .level,
        wire::ContainmentLevel::HardAggregate as i32
    );
    assert_handoff_endpoints(&handoff.endpoints, &launch.protected_endpoints);
}

fn assert_handoff_endpoints(
    actual: &[wire::RunnerLaunchEndpoint],
    expected: &[wire::ProtectedAttemptEndpoint],
) {
    assert_eq!(actual.len(), expected.len());
    for (actual, expected) in actual.iter().zip(expected) {
        assert_eq!(actual.kind, expected.kind);
        assert_eq!(actual.endpoint_id, expected.endpoint_id);
        assert_eq!(actual.address, expected.address);
        assert_eq!(actual.connection_id, expected.connection_id);
        assert_eq!(actual.connection_token, expected.connection_token);
        assert_eq!(actual.max_frame_bytes, expected.max_frame_bytes);
        assert_endpoint_binding(actual);
    }
}

fn assert_endpoint_binding(endpoint: &wire::RunnerLaunchEndpoint) {
    let kind = wire::AttemptEndpointKind::try_from(endpoint.kind).expect("validated endpoint kind");
    #[cfg(windows)]
    {
        assert_eq!(
            endpoint.provisioning,
            wire::RunnerEndpointProvisioning::WindowsCreateNamedPipe as i32
        );
        assert_eq!(
            endpoint.listener_slot,
            wire::RunnerListenerSlot::Unspecified as i32
        );
    }
    #[cfg(unix)]
    {
        assert_eq!(
            endpoint.provisioning,
            wire::RunnerEndpointProvisioning::UnixReceiveBoundSocket as i32
        );
        let slot = match kind {
            wire::AttemptEndpointKind::Control => wire::RunnerListenerSlot::Control,
            wire::AttemptEndpointKind::Data => wire::RunnerListenerSlot::Data,
            wire::AttemptEndpointKind::RunnerPulse => wire::RunnerListenerSlot::RunnerPulse,
            wire::AttemptEndpointKind::Unspecified => unreachable!("validated endpoint"),
        };
        assert_eq!(endpoint.listener_slot, slot as i32);
    }
    let peer = match kind {
        wire::AttemptEndpointKind::Control | wire::AttemptEndpointKind::Data => {
            wire::RunnerExpectedPeerRole::Host
        }
        wire::AttemptEndpointKind::RunnerPulse => wire::RunnerExpectedPeerRole::Supervisor,
        wire::AttemptEndpointKind::Unspecified => unreachable!("validated endpoint"),
    };
    assert_eq!(endpoint.expected_peer_role, peer as i32);
}
