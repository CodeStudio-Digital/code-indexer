use std::time::{SystemTime, UNIX_EPOCH};

use agent_protocol::generated::v1 as wire;
use agent_protocol::version::ProtocolVersion;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};

use super::super::super::support::CONNECTION;

pub(super) fn header(
    message_id: String,
    stream_seq: u64,
    sent_at_unix_ms: i64,
    reply_to_message_id: Option<String>,
) -> wire::ManagementFrameHeader {
    wire::ManagementFrameHeader {
        protocol_version: ProtocolVersion::new(1, 1).to_wire(),
        connection_id: CONNECTION.into(),
        message_id,
        reply_to_message_id,
        stream_seq,
        sent_at_unix_ms,
        ..wire::ManagementFrameHeader::default()
    }
}

pub(super) async fn write_delimited(stream: &mut DuplexStream, encoded: &[u8]) {
    let mut length = u64::try_from(encoded.len()).expect("frame length");
    while length >= 0x80 {
        let byte = u8::try_from(length & 0x7f).expect("seven-bit varint chunk");
        stream
            .write_all(&[byte | 0x80])
            .await
            .expect("write frame prefix");
        length >>= 7;
    }
    stream
        .write_all(&[u8::try_from(length).expect("final varint byte")])
        .await
        .expect("write frame prefix");
    stream.write_all(encoded).await.expect("write frame");
}

pub(super) async fn read_delimited(stream: &mut DuplexStream) -> Vec<u8> {
    let mut length = 0_u64;
    for shift in (0..35).step_by(7) {
        let byte = stream.read_u8().await.expect("read frame prefix");
        length |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            let mut encoded = vec![0; usize::try_from(length).expect("bounded frame")];
            stream.read_exact(&mut encoded).await.expect("read frame");
            return encoded;
        }
    }
    panic!("invalid frame prefix");
}

pub(super) fn now_unix_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time")
            .as_millis(),
    )
    .expect("timestamp fits")
}
