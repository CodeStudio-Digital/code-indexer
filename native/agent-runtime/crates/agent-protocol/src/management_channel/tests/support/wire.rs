use std::io::Cursor;

use prost::Message;

use crate::framing::DelimitedFrameCodec;
use crate::generated::v1 as wire;
use crate::management_frame::encode_management_frame;
use crate::version::ProtocolVersion;

use super::fixtures::{CONNECTION, NOW, hard_cap_u32, payload, protocol, supervisor_hello};

pub fn frame(body: wire::management_payload::Body, message_id: &str, stream_seq: u64) -> Vec<u8> {
    frame_with_context(body, message_id, stream_seq, protocol(), CONNECTION, None)
}

pub fn frame_with_context(
    body: wire::management_payload::Body,
    message_id: &str,
    stream_seq: u64,
    protocol: ProtocolVersion,
    connection_id: &str,
    deadline: Option<i64>,
) -> Vec<u8> {
    frame_with_reply(
        body,
        message_id,
        stream_seq,
        protocol,
        connection_id,
        deadline,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn frame_with_reply(
    body: wire::management_payload::Body,
    message_id: &str,
    stream_seq: u64,
    protocol: ProtocolVersion,
    connection_id: &str,
    deadline: Option<i64>,
    reply_to: Option<&str>,
) -> Vec<u8> {
    encode_management_frame(
        wire::ManagementFrameHeader {
            protocol_version: protocol.to_wire(),
            connection_id: connection_id.into(),
            message_id: message_id.into(),
            reply_to_message_id: reply_to.map(str::to_owned),
            stream_seq,
            sent_at_unix_ms: NOW,
            deadline_at_unix_ms: deadline,
            ..wire::ManagementFrameHeader::default()
        },
        &payload(body),
    )
    .expect("frame")
}

pub fn supervisor_bootstrap_frame() -> Vec<u8> {
    frame(
        wire::management_payload::Body::SupervisorHello(supervisor_hello()),
        "supervisor-bootstrap",
        1,
    )
}

pub fn event(message: &str, seq: u64) -> Vec<u8> {
    frame(
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + i64::try_from(seq).expect("test sequence fits"),
            ..wire::SupervisorResourceSample::default()
        }),
        message,
        seq,
    )
}

pub fn delimited(frames: &[Vec<u8>]) -> Vec<u8> {
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    let mut bytes = Vec::new();
    for frame in frames {
        codec.write_raw(&mut bytes, frame).expect("delimit");
    }
    bytes
}

pub fn decode_delimited(bytes: &[u8]) -> Vec<Vec<u8>> {
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    let mut cursor = Cursor::new(bytes);
    let mut frames = Vec::new();
    while let Some(frame) = codec.read_raw(&mut cursor).expect("read output") {
        frames.push(frame);
    }
    frames
}

pub fn decode_frame(bytes: &[u8]) -> (wire::ManagementFrameHeader, wire::ManagementPayload) {
    let frame = wire::ManagementFrame::decode(bytes).expect("envelope");
    let payload =
        wire::ManagementPayload::decode(frame.encoded_payload.as_slice()).expect("payload");
    (frame.header.expect("header"), payload)
}
