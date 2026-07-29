use prost::Message;

use super::*;

fn encoded(body: wire::frame_payload::Body) -> Vec<u8> {
    wire::FramePayload { body: Some(body) }.encode_to_vec()
}

fn wire_identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "owner".into(),
        fencing_epoch: 7,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        owner_agent_run_id: Some("77777777-7777-4777-8777-777777777777".into()),
        parent_agent_run_id: None,
    }
}

fn frame(channel: wire::TransportChannel, encoded_payload: Vec<u8>) -> wire::Frame {
    let identity = wire_identity();
    wire::Frame {
        header: Some(wire::FrameHeader {
            protocol_version: ProtocolVersion::new(1, 1).to_wire(),
            connection_id: "connection".into(),
            message_id: "message".into(),
            session_id: identity.session_id,
            command_id: identity.command_id,
            agent_run_id: identity.agent_run_id,
            attempt_id: identity.attempt_id,
            executor_owner_id: identity.executor_owner_id,
            fencing_epoch: identity.fencing_epoch,
            correlation_id: identity.correlation_id,
            stream_seq: 1,
            sent_at_unix_ms: 1,
            payload_sha256: frame_payload_sha256(&encoded_payload).to_vec(),
            root_agent_run_id: identity.root_agent_run_id,
            owner_agent_run_id: identity.owner_agent_run_id,
            parent_agent_run_id: identity.parent_agent_run_id,
            ..wire::FrameHeader::default()
        }),
        channel: channel as i32,
        encoded_payload,
    }
}

#[allow(clippy::needless_pass_by_value)]
fn validate(
    frame: wire::Frame,
    channel: wire::TransportChannel,
) -> Result<ValidatedAttemptFrame, FrameValidationError> {
    validate_attempt_frame(&frame.encode_to_vec(), channel)
}

fn ack_payload() -> Vec<u8> {
    encoded(wire::frame_payload::Body::Ack(wire::Ack::default()))
}

fn bind_payload() -> Vec<u8> {
    encoded(wire::frame_payload::Body::BindAttemptChannel(
        wire::BindAttemptChannel {
            identity: Some(wire_identity()),
            ..wire::BindAttemptChannel::default()
        },
    ))
}

#[test]
fn exposes_immutable_caps_for_every_physical_channel() {
    assert_eq!(
        maximum_frame_bytes(wire::TransportChannel::Management),
        Some(64 * 1024)
    );
    assert_eq!(
        maximum_frame_bytes(wire::TransportChannel::Pulse),
        Some(4 * 1024)
    );
    assert_eq!(
        maximum_frame_bytes(wire::TransportChannel::Control),
        Some(256 * 1024)
    );
    assert_eq!(
        maximum_frame_bytes(wire::TransportChannel::Data),
        Some(1024 * 1024)
    );
    assert_eq!(
        maximum_frame_bytes(wire::TransportChannel::Unspecified),
        None
    );
}

#[test]
fn payload_hash_matches_the_protocol_domain_vector() {
    assert_eq!(
        frame_payload_sha256(&[1, 2, 3]),
        [
            0x59, 0xf1, 0x53, 0xd0, 0x1c, 0xbf, 0x8a, 0xd4, 0x53, 0x62, 0x96, 0xac, 0x42, 0x6d,
            0x22, 0x48, 0xde, 0x22, 0xcc, 0x38, 0xfe, 0xd3, 0x7e, 0x8f, 0x8c, 0x5d, 0xed, 0x4d,
            0xd4, 0xa3, 0x44, 0x75,
        ]
    );
}

#[test]
fn envelope_hash_matches_the_cross_language_golden_vector() {
    assert_eq!(
        frame_envelope_sha256(&[1, 2, 3]),
        [
            0xd7, 0x8c, 0xaa, 0xf1, 0x8b, 0xe4, 0x48, 0xa2, 0x8b, 0x86, 0xc6, 0xa1, 0x9f, 0xc9,
            0xc3, 0xdd, 0xe5, 0x8c, 0x6e, 0xf2, 0xf1, 0x49, 0xa8, 0x82, 0xb8, 0xe8, 0xb8, 0xfe,
            0x28, 0xb5, 0x1b, 0x28,
        ]
    );
}

#[test]
fn accepts_control_and_current_data_payloads() {
    let control = validate(
        frame(wire::TransportChannel::Control, ack_payload()),
        wire::TransportChannel::Control,
    )
    .expect("control payload should validate");
    assert_eq!(control.channel, wire::TransportChannel::Control);

    let data = validate(
        frame(wire::TransportChannel::Data, bind_payload()),
        wire::TransportChannel::Data,
    )
    .expect("data binding payload should validate");
    assert_eq!(data.channel, wire::TransportChannel::Data);
}

#[test]
fn rejects_missing_unknown_unspecified_and_cross_wired_channels() {
    let mut missing_header = frame(wire::TransportChannel::Control, ack_payload());
    missing_header.header = None;
    assert!(matches!(
        validate(missing_header, wire::TransportChannel::Control),
        Err(FrameValidationError::MissingHeader)
    ));

    let mut unknown = frame(wire::TransportChannel::Control, ack_payload());
    unknown.channel = 99;
    assert!(matches!(
        validate(unknown, wire::TransportChannel::Control),
        Err(FrameValidationError::UnknownChannel(99))
    ));

    let unspecified = frame(wire::TransportChannel::Unspecified, ack_payload());
    assert!(matches!(
        validate(unspecified, wire::TransportChannel::Control),
        Err(FrameValidationError::UnspecifiedChannel)
    ));

    let cross_wired = frame(wire::TransportChannel::Control, ack_payload());
    assert!(matches!(
        validate(cross_wired, wire::TransportChannel::Data),
        Err(FrameValidationError::UnexpectedChannel {
            expected: wire::TransportChannel::Data,
            actual: wire::TransportChannel::Control,
        })
    ));
}

#[test]
fn rejects_empty_and_oversized_payloads_before_digest_work() {
    let empty = frame(wire::TransportChannel::Control, Vec::new());
    assert!(matches!(
        validate(empty, wire::TransportChannel::Control),
        Err(FrameValidationError::EmptyPayload)
    ));

    let oversized = vec![0_u8; PULSE_FRAME_MAX_BYTES + 1];
    let pulse = frame(wire::TransportChannel::Pulse, oversized);
    assert!(matches!(
        validate(pulse, wire::TransportChannel::Pulse),
        Err(FrameValidationError::FrameTooLarge {
            channel: wire::TransportChannel::Pulse,
            maximum: PULSE_FRAME_MAX_BYTES,
            ..
        })
    ));
}

#[test]
fn validates_digest_length_and_original_payload_bytes_before_decode() {
    let mut short_digest = frame(wire::TransportChannel::Control, ack_payload());
    short_digest.header.as_mut().expect("header").payload_sha256 = vec![0_u8; 31];
    assert!(matches!(
        validate(short_digest, wire::TransportChannel::Control),
        Err(FrameValidationError::InvalidDigestLength(31))
    ));

    let mut malformed_with_wrong_digest = frame(wire::TransportChannel::Control, vec![0xff, 0xff]);
    malformed_with_wrong_digest
        .header
        .as_mut()
        .expect("header")
        .payload_sha256 = vec![0_u8; 32];
    assert!(matches!(
        validate(malformed_with_wrong_digest, wire::TransportChannel::Control),
        Err(FrameValidationError::DigestMismatch)
    ));

    let malformed = frame(wire::TransportChannel::Control, vec![0xff, 0xff]);
    assert!(matches!(
        validate(malformed, wire::TransportChannel::Control),
        Err(FrameValidationError::MalformedPayload(_))
    ));
}

#[test]
fn rejects_payload_without_a_body() {
    let empty_message = wire::FramePayload::default().encode_to_vec();
    let candidate = frame(wire::TransportChannel::Control, empty_message);
    assert!(matches!(
        validate(candidate, wire::TransportChannel::Control),
        Err(FrameValidationError::EmptyPayload)
    ));

    // An unknown field makes the encoded message non-empty but still supplies
    // no known oneof body.
    let unknown_only = vec![0xa0, 0x06, 0x01];
    let candidate = frame(wire::TransportChannel::Control, unknown_only);
    assert!(matches!(
        validate(candidate, wire::TransportChannel::Control),
        Err(FrameValidationError::MissingPayloadBody)
    ));
}

#[test]
fn hashes_unknown_payload_fields_without_normalizing_them() {
    let mut with_unknown_field = ack_payload();
    with_unknown_field.extend_from_slice(&[0xa0, 0x06, 0x01]);
    let validated = validate(
        frame(wire::TransportChannel::Control, with_unknown_field.clone()),
        wire::TransportChannel::Control,
    )
    .expect("unknown fields covered by the wire digest must be accepted");

    assert!(matches!(&validated.body, wire::frame_payload::Body::Ack(_)));

    let normalized = wire::FramePayload {
        body: Some(validated.body),
    }
    .encode_to_vec();
    assert_ne!(
        frame_payload_sha256(&with_unknown_field),
        frame_payload_sha256(&normalized)
    );
}

#[test]
fn enforces_channel_allowlists_and_dedicated_envelopes() {
    let control_binding = frame(wire::TransportChannel::Control, bind_payload());
    assert!(matches!(
        validate(control_binding, wire::TransportChannel::Control),
        Err(FrameValidationError::PayloadNotAllowed {
            channel: wire::TransportChannel::Control,
            payload: "BindAttemptChannel",
        })
    ));

    let data_ack = frame(wire::TransportChannel::Data, ack_payload());
    assert!(matches!(
        validate(data_ack, wire::TransportChannel::Data),
        Err(FrameValidationError::PayloadNotAllowed {
            channel: wire::TransportChannel::Data,
            payload: "Ack",
        })
    ));

    for channel in [
        wire::TransportChannel::Management,
        wire::TransportChannel::Pulse,
    ] {
        let candidate = frame(channel, ack_payload());
        assert!(matches!(
            validate(candidate, channel),
            Err(FrameValidationError::DedicatedFrameRequired(actual)) if actual == channel
        ));
    }
}

mod async_established;
mod authority_tests;
