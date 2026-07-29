use std::io::Cursor;

use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use agent_protocol::management_frame::{MANAGEMENT_FRAME_MAX_BYTES, validate_management_frame};

use super::{TestWriter, frame_with_reply};

pub(in crate::management::driver::tests) fn ack_frame_for_output(
    writer: &TestWriter,
    output_index: usize,
    message_id: &str,
    stream_seq: u64,
) -> Vec<u8> {
    ack_frame(writer, output_index, message_id, stream_seq, false)
}

pub(in crate::management::driver::tests) fn wrong_digest_ack_frame_for_output(
    writer: &TestWriter,
    output_index: usize,
    message_id: &str,
    stream_seq: u64,
) -> Vec<u8> {
    ack_frame(writer, output_index, message_id, stream_seq, true)
}

fn ack_frame(
    writer: &TestWriter,
    output_index: usize,
    message_id: &str,
    stream_seq: u64,
    corrupt_digest: bool,
) -> Vec<u8> {
    let header = output_headers(writer)
        .into_iter()
        .nth(output_index)
        .expect("outbound frame index");
    let mut digest = header.payload_sha256.clone();
    if corrupt_digest {
        digest[0] ^= 1;
    }
    let acknowledged_at_unix_ms = header.sent_at_unix_ms;
    frame_with_reply(
        wire::management_payload::Body::ManagementAck(wire::ManagementAck {
            acknowledged_message_id: header.message_id.clone(),
            acknowledged_payload_sha256: digest,
            acknowledged_at_unix_ms,
        }),
        message_id,
        stream_seq,
        acknowledged_at_unix_ms,
        Some(header.message_id),
    )
}

fn output_headers(writer: &TestWriter) -> Vec<wire::ManagementFrameHeader> {
    let codec = DelimitedFrameCodec::new(
        u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management frame cap"),
    )
    .expect("codec");
    let mut cursor = Cursor::new(writer.bytes());
    let mut headers = Vec::new();
    while let Some(encoded) = codec.read_raw(&mut cursor).expect("output frame") {
        let validated = validate_management_frame(&encoded).expect("valid output frame");
        headers.push(validated.frame.header.clone().expect("output header"));
    }
    headers
}
