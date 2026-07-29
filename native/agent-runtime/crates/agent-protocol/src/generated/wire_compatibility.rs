use prost::Message;

use super::v1::{Ack, Frame, FrameHeader, FramePayload, TransportChannel, frame_payload};

const GOLDEN_HEX: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../../packages/agent-runtime-contracts/fixtures/v1/frame-ack.hex"
));

fn decode_hex(source: &str) -> Vec<u8> {
    let source = source.trim().as_bytes();
    assert!(source.len().is_multiple_of(2), "fixture hex must be paired");
    source
        .chunks_exact(2)
        .map(|pair| {
            let pair = std::str::from_utf8(pair).expect("fixture must be ASCII");
            u8::from_str_radix(pair, 16).expect("fixture must contain valid hex")
        })
        .collect()
}

fn golden_payload() -> FramePayload {
    FramePayload {
        body: Some(frame_payload::Body::Ack(Ack {
            acknowledged_message_id: "msg:opaque/0".into(),
            acknowledged_payload_sha256: (224_u8..=255).rev().collect(),
            acknowledged_at_unix_ms: 1_784_894_400_456,
        })),
    }
}

fn golden_frame() -> Frame {
    let encoded_payload = golden_payload().encode_to_vec();
    Frame {
        header: Some(FrameHeader {
            protocol_version: 65_537,
            connection_id: "conn:alpha".into(),
            message_id: "msg:opaque/1".into(),
            reply_to_message_id: Some("msg:prior".into()),
            session_id: "11111111-1111-4111-8111-111111111111".into(),
            command_id: "22222222-2222-4222-8222-222222222222".into(),
            agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
            attempt_id: "44444444-4444-4444-8444-444444444444".into(),
            executor_owner_id: "host:desktop".into(),
            fencing_epoch: 9_007_199_254_740_993,
            correlation_id: "55555555-5555-4555-8555-555555555555".into(),
            stream_seq: 18_446_744_073_709_551_614,
            sent_at_unix_ms: 1_784_894_400_123,
            deadline_at_unix_ms: Some(1_784_894_460_123),
            payload_sha256: decode_hex(
                "3b263badc1b6dc62cd4592a5082292f30b3fc9180d584cb218fb75581398df08",
            ),
            operation_id: Some("operation:read/7".into()),
            tool_use_id: Some(String::new()),
            // This raw wire-compatibility vector intentionally preserves the
            // defaulted post-v1 graph fields; semantic dispatch still rejects
            // a missing root agent run through `identity_from_wire`.
            root_agent_run_id: String::new(),
            owner_agent_run_id: None,
            parent_agent_run_id: None,
        }),
        channel: TransportChannel::Control.into(),
        encoded_payload,
    }
}

#[test]
fn rust_encodes_the_shared_golden_frame_byte_for_byte() {
    let encoded = golden_frame().encode_to_vec();

    assert_eq!(encoded, decode_hex(GOLDEN_HEX));
    assert_eq!(encoded.len(), 400);
}

#[test]
fn rust_preserves_uint64_optional_presence_and_oneof() {
    let decoded = Frame::decode(decode_hex(GOLDEN_HEX).as_slice()).expect("valid golden frame");
    let header = decoded.header.expect("frame header");
    let payload =
        FramePayload::decode(decoded.encoded_payload.as_slice()).expect("valid frame payload");

    assert_eq!(header.fencing_epoch, 9_007_199_254_740_993);
    assert_eq!(header.stream_seq, 18_446_744_073_709_551_614);
    assert_eq!(header.tool_use_id.as_deref(), Some(""));
    assert!(matches!(payload.body, Some(frame_payload::Body::Ack(_))));
}

#[test]
fn rust_preserves_an_unknown_enum_value_for_fail_closed_validation() {
    let mut frame = golden_frame();
    frame.channel = 99;
    let decoded = Frame::decode(frame.encode_to_vec().as_slice()).expect("valid frame");

    assert_eq!(decoded.channel, 99);
    assert!(TransportChannel::try_from(decoded.channel).is_err());
}

#[test]
fn rust_preserves_opaque_payload_bytes_before_payload_decode() {
    let mut encoded_payload = golden_payload().encode_to_vec();
    encoded_payload.extend_from_slice(&[0x98, 0x06, 0x07]);
    let mut frame = golden_frame();
    frame.encoded_payload.clone_from(&encoded_payload);

    let decoded = Frame::decode(frame.encode_to_vec().as_slice()).expect("valid outer frame");
    assert_eq!(decoded.encoded_payload, encoded_payload);

    let payload = FramePayload::decode(decoded.encoded_payload.as_slice()).expect("valid payload");
    assert!(matches!(payload.body, Some(frame_payload::Body::Ack(_))));
}
