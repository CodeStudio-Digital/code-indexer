use std::convert::Infallible;

use prost::Message;

use crate::generated::v1 as wire;

use super::{
    AwaitingRunnerEndpointsReady, PreparedRunnerLaunchHandoff, RUNNER_ENDPOINTS_READY_MAX_BYTES,
    RUNNER_LAUNCH_HANDOFF_MAX_BYTES, RunnerBootstrapError, decode_runner_launch_handoff,
    prepare_runner_launch_handoff, runner_launch_handoff_sha256,
};

mod agent_hello;
mod scrub_errors;
mod support;
mod transport;
mod validation;

#[test]
fn windows_handoff_round_trips_and_ready_is_bound_to_exact_bytes() {
    let prepared =
        prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
    let debug = format!("{prepared:?}");
    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains(r"\\.\pipe\control-7"));

    let (encoded, awaiting_ready) = transmit(prepared);
    let mut received = decode_runner_launch_handoff(encoded).expect("valid frame");
    let digest = *received.original_frame_sha256();
    assert_eq!(received.metadata().endpoints.len(), 3);
    assert!(received.metadata().launch_nonce.is_empty());
    assert!(
        received
            .metadata()
            .endpoints
            .iter()
            .all(|endpoint| endpoint.connection_token.is_empty())
    );
    assert!(received.launch_nonce_matches(&(1_u8..=32).collect::<Vec<_>>()));
    let verifier = received
        .take_endpoint_token_verifier(wire::AttemptEndpointKind::Control)
        .expect("known endpoint");
    assert!(verifier.is_bound_to(
        &digest,
        wire::AttemptEndpointKind::Control,
        "connection:control/7"
    ));
    assert!(verifier.matches(&[0x11; 16]));
    assert!(!verifier.matches(&[0x44; 16]));
    assert!(
        received
            .take_endpoint_token_verifier(wire::AttemptEndpointKind::Control)
            .is_err()
    );
    assert!(format!("{received:?}").contains("[REDACTED]"));
    let nonce = received
        .take_launch_nonce()
        .expect("single-use launch nonce");
    let pending = nonce
        .prepare_agent_hello(wire::AgentHello::default())
        .expect("empty draft");
    assert!(format!("{pending:?}").contains("NONCE REDACTED"));
    drop(pending);
    assert!(received.take_launch_nonce().is_none());

    let ready = received
        .encode_ready_for_test()
        .expect("bounded readiness evidence");
    let matched = awaiting_ready
        .accept_ready(&ready)
        .expect("matching ready evidence");

    assert_eq!(matched.wire().acknowledged_handoff_sha256, digest);
    assert_eq!(matched.wire().runner_process_id, 303);
    assert_eq!(matched.wire().endpoints.len(), 3);
}

#[test]
fn unix_handoff_requires_and_accepts_exact_listener_slots_and_uids() {
    let prepared = prepare_runner_launch_handoff(support::unix_handoff()).expect("valid handoff");
    let (encoded, _awaiting_ready) = transmit(prepared);
    let received = decode_runner_launch_handoff(encoded).expect("valid frame");

    assert_eq!(
        received.metadata().endpoints[2].listener_slot,
        wire::RunnerListenerSlot::RunnerPulse as i32
    );
    assert_eq!(
        received
            .metadata()
            .expected_host_peer
            .as_ref()
            .expect("host peer")
            .unix_user_id,
        Some(1_000)
    );
}

#[test]
fn size_caps_are_enforced_before_protobuf_decode() {
    assert!(matches!(
        decode_runner_launch_handoff(Vec::new()),
        Err(RunnerBootstrapError::EmptyMessage("RunnerLaunchHandoff"))
    ));
    assert!(matches!(
        decode_runner_launch_handoff(vec![0; RUNNER_LAUNCH_HANDOFF_MAX_BYTES + 1]),
        Err(RunnerBootstrapError::MessageTooLarge {
            message: "RunnerLaunchHandoff",
            ..
        })
    ));

    let prepared =
        prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
    let (_encoded, awaiting_ready) = transmit(prepared);
    assert!(matches!(
        awaiting_ready.accept_ready(&vec![0; RUNNER_ENDPOINTS_READY_MAX_BYTES + 1]),
        Err(RunnerBootstrapError::MessageTooLarge {
            message: "RunnerEndpointsReady",
            ..
        })
    ));
}

#[test]
fn ready_must_match_digest_identity_process_and_exact_endpoint_order() {
    for field in ["digest", "identity", "process", "endpoints"] {
        let prepared =
            prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
        let (encoded, awaiting_ready) = transmit(prepared);
        let received = decode_runner_launch_handoff(encoded).expect("valid frame");
        let mut ready = wire::RunnerEndpointsReady::decode(
            received
                .encode_ready_for_test()
                .expect("ready bytes")
                .as_slice(),
        )
        .expect("ready message");
        match field {
            "digest" => ready.acknowledged_handoff_sha256[0] ^= 0xff,
            "identity" => ready
                .identity
                .as_mut()
                .expect("identity")
                .attempt_id
                .push('x'),
            "process" => ready.runner_process_id += 1,
            "endpoints" => ready.endpoints.swap(0, 1),
            _ => unreachable!(),
        }

        let error = awaiting_ready
            .accept_ready(&ready.encode_to_vec())
            .expect_err("mismatch must fail");
        assert!(
            matches!(error, RunnerBootstrapError::ReadyMismatch(_)),
            "{field}: {error}"
        );
    }
}

#[test]
fn failed_transmit_does_not_create_ready_authority() {
    let prepared =
        prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
    let error = prepared
        .transmit_with(|_| Err::<(), _>("write failed"))
        .expect_err("failed write must consume the frame");

    assert_eq!(error, "write failed");
}

#[test]
fn decoded_digest_and_test_ready_cover_unknown_original_fields() {
    let prepared =
        prepare_runner_launch_handoff(support::windows_handoff()).expect("valid handoff");
    let (mut encoded, _awaiting_ready) = transmit(prepared);
    encoded.extend_from_slice(&[0x98, 0x06, 0x07]); // field 99, varint 7
    let expected_digest = runner_launch_handoff_sha256(&encoded);

    let received = decode_runner_launch_handoff(encoded).expect("shape remains valid");
    let ready = wire::RunnerEndpointsReady::decode(
        received
            .encode_ready_for_test()
            .expect("bounded ready")
            .as_slice(),
    )
    .expect("ready message");

    assert_eq!(received.original_frame_sha256(), &expected_digest);
    assert_eq!(ready.acknowledged_handoff_sha256, expected_digest);
}

fn transmit(prepared: PreparedRunnerLaunchHandoff) -> (Vec<u8>, AwaitingRunnerEndpointsReady) {
    let mut encoded = Vec::new();
    let awaiting = prepared
        .transmit_with(|frame| {
            encoded.extend_from_slice(frame);
            Ok::<_, Infallible>(())
        })
        .expect("infallible transport");
    (encoded, awaiting)
}
