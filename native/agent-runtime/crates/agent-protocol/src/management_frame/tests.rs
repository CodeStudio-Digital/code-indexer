use prost::Message;

use super::*;

fn payload_bytes() -> Vec<u8> {
    wire::ManagementPayload {
        body: Some(wire::management_payload::Body::ManagementAck(
            wire::ManagementAck {
                acknowledged_message_id: "message:prior".into(),
                acknowledged_payload_sha256: vec![7; 32],
                acknowledged_at_unix_ms: 3,
            },
        )),
    }
    .encode_to_vec()
}

fn raw_frame(encoded_payload: Vec<u8>, digest: Vec<u8>) -> Vec<u8> {
    wire::ManagementFrame {
        header: Some(wire::ManagementFrameHeader {
            protocol_version: 65_537,
            connection_id: "connection:test".into(),
            message_id: "message:test".into(),
            payload_sha256: digest,
            ..wire::ManagementFrameHeader::default()
        }),
        encoded_payload,
    }
    .encode_to_vec()
}

fn valid_frame(encoded_payload: Vec<u8>) -> Vec<u8> {
    let digest = management_payload_sha256(&encoded_payload).to_vec();
    raw_frame(encoded_payload, digest)
}

#[test]
fn decoded_frame_guard_scrubs_the_opaque_payload_copy() {
    let mut frame = wire::ManagementFrame {
        encoded_payload: vec![1, 2, 3, 4],
        ..Default::default()
    };

    scrub_encoded_frame(&mut frame);

    assert_eq!(frame.encoded_payload, [0, 0, 0, 0]);
}

#[test]
fn payload_hash_matches_the_management_domain_vector() {
    assert_eq!(
        management_payload_sha256(&[1, 2, 3]),
        [
            0x7c, 0x6f, 0x63, 0xd4, 0x30, 0x16, 0xb2, 0x8b, 0x39, 0xea, 0x3e, 0x8b, 0xd4, 0xfa,
            0x78, 0xda, 0xe1, 0xb6, 0xf4, 0xbd, 0x20, 0xbd, 0x5e, 0xb2, 0xaf, 0x79, 0x65, 0x9a,
            0x1a, 0xde, 0x89, 0x77,
        ]
    );
}

#[test]
fn round_trips_an_allowed_management_payload() {
    let payload = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::QuerySupervisorState(
            wire::QuerySupervisorState::default(),
        )),
    };
    let bytes = encode_management_frame(wire::ManagementFrameHeader::default(), &payload)
        .expect("management frame should encode");
    let validated = validate_management_frame(&bytes).expect("management frame should validate");

    assert!(matches!(
        validated.payload.body.as_ref(),
        Some(wire::management_payload::Body::QuerySupervisorState(_))
    ));
    assert_eq!(
        validated
            .frame
            .header
            .as_ref()
            .expect("header")
            .payload_sha256
            .len(),
        32
    );
}

#[test]
fn hashes_unknown_payload_fields_without_normalizing_them() {
    let mut opaque_payload = payload_bytes();
    opaque_payload.extend_from_slice(&[0x98, 0x06, 0x07]);
    let validated = validate_management_frame(&valid_frame(opaque_payload.clone()))
        .expect("unknown payload fields should remain covered by the digest");

    assert!(matches!(
        validated.payload.body.as_ref(),
        Some(wire::management_payload::Body::ManagementAck(_))
    ));
    assert_ne!(
        management_payload_sha256(&opaque_payload),
        management_payload_sha256(&validated.payload.encode_to_vec())
    );
}

#[test]
fn rejects_payload_mutation_and_invalid_digest_lengths() {
    let mut mutated = payload_bytes();
    let digest = management_payload_sha256(&mutated).to_vec();
    let last = mutated.len() - 1;
    mutated[last] ^= 1;
    assert!(matches!(
        validate_management_frame(&raw_frame(mutated, digest)),
        Err(ManagementFrameError::DigestMismatch)
    ));

    assert!(matches!(
        validate_management_frame(&raw_frame(payload_bytes(), vec![0; 31])),
        Err(ManagementFrameError::InvalidDigestLength(31))
    ));
}

#[test]
fn rejects_empty_and_oversized_envelopes_before_decode() {
    assert!(matches!(
        validate_management_frame(&[]),
        Err(ManagementFrameError::EmptyFrame)
    ));
    assert!(matches!(
        validate_management_frame(&vec![0; MANAGEMENT_FRAME_MAX_BYTES + 1]),
        Err(ManagementFrameError::FrameTooLarge {
            maximum: MANAGEMENT_FRAME_MAX_BYTES,
            ..
        })
    ));
}

#[test]
fn rejects_malformed_envelopes_and_payloads_without_panicking() {
    assert!(matches!(
        validate_management_frame(&[0xff]),
        Err(ManagementFrameError::MalformedFrame(_))
    ));

    let malformed_payload = vec![0xff];
    assert!(matches!(
        validate_management_frame(&valid_frame(malformed_payload)),
        Err(ManagementFrameError::MalformedPayload(_))
    ));

    let mut partial_secret = wire::ManagementPayload {
        body: Some(wire::management_payload::Body::HostSupervisorHello(
            wire::HostSupervisorHello {
                management_session_token: vec![0xa5; 32],
                ..wire::HostSupervisorHello::default()
            },
        )),
    }
    .encode_to_vec();
    partial_secret.push(0xff);
    assert!(matches!(
        validate_management_frame(&valid_frame(partial_secret)),
        Err(ManagementFrameError::MalformedPayload(_))
    ));
}

#[test]
fn rejects_missing_headers_empty_payloads_and_missing_bodies() {
    let missing_header = wire::ManagementFrame {
        header: None,
        encoded_payload: payload_bytes(),
    }
    .encode_to_vec();
    assert!(matches!(
        validate_management_frame(&missing_header),
        Err(ManagementFrameError::MissingHeader)
    ));

    let empty_payload = raw_frame(Vec::new(), management_payload_sha256(&[]).to_vec());
    assert!(matches!(
        validate_management_frame(&empty_payload),
        Err(ManagementFrameError::EmptyPayload)
    ));

    let unknown_only = vec![0x98, 0x06, 0x07];
    assert!(matches!(
        validate_management_frame(&valid_frame(unknown_only)),
        Err(ManagementFrameError::MissingPayloadBody)
    ));
}

#[test]
fn rejects_encoding_a_payload_without_a_management_body() {
    assert!(matches!(
        encode_management_frame(
            wire::ManagementFrameHeader::default(),
            &wire::ManagementPayload::default()
        ),
        Err(ManagementFrameError::MissingPayloadBody)
    ));
}
