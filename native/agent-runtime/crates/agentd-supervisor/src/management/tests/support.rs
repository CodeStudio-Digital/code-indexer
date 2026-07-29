use std::io::{self, Cursor, Write};
use std::sync::{Arc, Mutex};

use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::encode_management_frame;
use agent_protocol::version::ProtocolVersion;

mod fixtures;

pub(in crate::management::tests) use fixtures::*;

pub(super) const CONNECTION: &str = "management:supervisor-facade";
pub(super) const NONCE: [u8; 32] = [4; 32];
pub(super) const TOKEN: [u8; 32] = [3; 32];

#[derive(Clone, Debug, Default)]
pub(super) struct RecordingWriter(Arc<Mutex<Vec<u8>>>);

impl RecordingWriter {
    pub(super) fn bytes(&self) -> Vec<u8> {
        self.0.lock().expect("writer lock").clone()
    }
}

impl Write for RecordingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().expect("writer lock").extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(super) fn frame(
    body: wire::management_payload::Body,
    message_id: &str,
    stream_seq: u64,
) -> Vec<u8> {
    encode_management_frame(
        wire::ManagementFrameHeader {
            protocol_version: ProtocolVersion::new(1, 1).to_wire(),
            connection_id: CONNECTION.into(),
            message_id: message_id.into(),
            stream_seq,
            sent_at_unix_ms: 90,
            ..wire::ManagementFrameHeader::default()
        },
        &wire::ManagementPayload { body: Some(body) },
    )
    .expect("frame")
}

pub(super) fn delimit(frames: &[Vec<u8>]) -> Vec<u8> {
    let codec = DelimitedFrameCodec::new(64 * 1024).expect("codec");
    let mut bytes = Vec::new();
    for frame in frames {
        codec.write_raw(&mut bytes, frame).expect("delimit");
    }
    bytes
}

pub(super) fn decode_delimited(bytes: &[u8]) -> Vec<Vec<u8>> {
    let codec = DelimitedFrameCodec::new(64 * 1024).expect("codec");
    let mut cursor = Cursor::new(bytes);
    let mut frames = Vec::new();
    while let Some(frame) = codec.read_raw(&mut cursor).expect("output") {
        frames.push(frame);
    }
    frames
}
