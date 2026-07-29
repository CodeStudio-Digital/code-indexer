use prost::Message;

use super::super::secrets::{SecretField, capture_scrub_audit};
use super::super::{RunnerBootstrapError, decode_runner_launch_handoff};
use super::support;

#[test]
fn validation_error_scrubs_every_decoded_secret() {
    let mut handoff = support::windows_handoff();
    handoff.schema_version = 0;
    let encoded = handoff.encode_to_vec();
    drop(handoff);

    let (result, audit) = capture_scrub_audit(|| decode_runner_launch_handoff(encoded));

    assert!(matches!(
        result,
        Err(RunnerBootstrapError::InvalidField {
            message: "RunnerLaunchHandoff",
            field: "schema_version",
        })
    ));
    assert_scrubbed(&audit, SecretField::LaunchNonce, 32);
    assert_eq!(
        audit
            .iter()
            .filter(|entry| entry.field == SecretField::EndpointToken && entry.length == 16)
            .count(),
        6,
        "each endpoint is scrubbed by both the handoff guard and its own drop"
    );
}

#[test]
fn prost_error_after_complete_message_scrubs_all_secrets() {
    let handoff = support::windows_handoff();
    let mut encoded = handoff.encode_to_vec();
    drop(handoff);
    // Structurally skippable by preflight, but Prost rejects this duplicate
    // schema_version after every valid field has already been merged.
    encoded.extend_from_slice(&[0x0a, 0x00]);

    let (result, audit) = capture_scrub_audit(|| decode_runner_launch_handoff(encoded));

    assert!(matches!(
        result,
        Err(RunnerBootstrapError::MalformedMessage {
            message: "RunnerLaunchHandoff",
            ..
        })
    ));
    assert_scrubbed(&audit, SecretField::LaunchNonce, 32);
    assert_scrubbed(&audit, SecretField::EndpointToken, 16);
}

#[test]
fn prost_utf8_error_inside_partial_endpoint_scrubs_unattached_token() {
    let token = [0x5a; 16];
    let mut endpoint = vec![0x2a, 0x10]; // endpoint field 5: connection_token
    endpoint.extend_from_slice(&token);
    endpoint.extend_from_slice(&[0x12, 0x01, 0xff]); // invalid UTF-8 endpoint_id
    let mut encoded = vec![0x2a, u8::try_from(endpoint.len()).expect("small endpoint")]; // handoff field 5: endpoints
    encoded.extend_from_slice(&endpoint);

    let (result, audit) = capture_scrub_audit(|| decode_runner_launch_handoff(encoded));

    assert!(matches!(
        result,
        Err(RunnerBootstrapError::MalformedMessage {
            message: "RunnerLaunchHandoff",
            ..
        })
    ));
    assert_scrubbed(&audit, SecretField::EndpointToken, token.len());
}

#[test]
fn duplicate_nonce_is_rejected_before_prost_copies_either_value() {
    let nonce = [0x7c; 16];
    let mut encoded = Vec::new();
    for _ in 0..2 {
        encoded.extend_from_slice(&[0x32, 0x10]); // handoff field 6: launch_nonce
        encoded.extend_from_slice(&nonce);
    }

    let (result, audit) = capture_scrub_audit(|| decode_runner_launch_handoff(encoded));

    assert!(matches!(
        result,
        Err(RunnerBootstrapError::MalformedMessage {
            message: "RunnerLaunchHandoff",
            ..
        })
    ));
    assert!(
        audit.is_empty(),
        "duplicate preflight must reject before decoded secret ownership: {audit:?}"
    );
}

#[test]
fn duplicate_endpoint_token_is_rejected_before_prost_copies_either_value() {
    let token = [0x4d; 16];
    let mut endpoint = Vec::new();
    for _ in 0..2 {
        endpoint.extend_from_slice(&[0x2a, 0x10]); // endpoint field 5: connection_token
        endpoint.extend_from_slice(&token);
    }
    let mut encoded = vec![0x2a, u8::try_from(endpoint.len()).expect("small endpoint")];
    encoded.extend_from_slice(&endpoint);

    let (result, audit) = capture_scrub_audit(|| decode_runner_launch_handoff(encoded));

    assert!(matches!(
        result,
        Err(RunnerBootstrapError::MalformedMessage {
            message: "RunnerLaunchHandoff",
            ..
        })
    ));
    assert!(
        audit.is_empty(),
        "duplicate preflight must reject before decoded secret ownership: {audit:?}"
    );
}

fn assert_scrubbed(audit: &[super::super::secrets::ScrubAudit], field: SecretField, length: usize) {
    assert!(
        audit
            .iter()
            .any(|entry| entry.field == field && entry.length == length),
        "missing {field:?} scrub of {length} bytes: {audit:?}"
    );
    assert!(
        audit.iter().all(|entry| entry.all_zero),
        "scrub observer saw non-zero bytes: {audit:?}"
    );
}
