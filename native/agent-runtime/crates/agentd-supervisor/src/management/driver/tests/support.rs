use std::io::{self, Cursor, Read, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use agent_protocol::framing::DelimitedFrameCodec;
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::ManagementReplayLimits;
use agent_protocol::management_frame::{
    MANAGEMENT_FRAME_MAX_BYTES, encode_management_frame, validate_management_frame,
};
use agent_protocol::version::ProtocolVersion;

use crate::management::{SupervisorManagementBootstrap, SupervisorManagementChannel};

mod ack_wire;
mod fixtures;

pub(super) use ack_wire::{ack_frame_for_output, wrong_digest_ack_frame_for_output};
pub(super) use fixtures::{
    host_hello_with_maximum_in_flight, launch_attempt, peer_authority, trusted_runner,
};

pub(super) const CONNECTION: &str = "management:physical-driver";
pub(super) const NONCE: [u8; 32] = [4; 32];
pub(super) const TOKEN: [u8; 32] = [3; 32];

#[derive(Debug, Default)]
struct WriterState {
    bytes: Mutex<Vec<u8>>,
    calls: AtomicUsize,
    fail_at: AtomicUsize,
}

#[derive(Clone, Debug, Default)]
pub(super) struct TestWriter(Arc<WriterState>);

impl TestWriter {
    pub(super) fn fail_on_next_write(&self) {
        let next = self.0.calls.load(Ordering::SeqCst) + 1;
        self.0.fail_at.store(next, Ordering::SeqCst);
    }

    pub(super) fn bytes(&self) -> Vec<u8> {
        self.0.bytes.lock().expect("writer bytes").clone()
    }
}

impl Write for TestWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let call = self.0.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let fail_at = self.0.fail_at.load(Ordering::SeqCst);
        if fail_at != 0 && call >= fail_at {
            return Err(io::Error::other("injected management write failure"));
        }
        self.0
            .bytes
            .lock()
            .expect("writer bytes")
            .extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[derive(Debug, Default)]
struct AppendableState {
    bytes: Vec<u8>,
    offset: usize,
}

#[derive(Clone, Debug, Default)]
pub(super) struct AppendableReader(Arc<Mutex<AppendableState>>);

impl AppendableReader {
    fn new(bytes: Vec<u8>) -> Self {
        Self(Arc::new(Mutex::new(AppendableState { bytes, offset: 0 })))
    }

    pub(super) fn append_frame(&self, frame: Vec<u8>) {
        self.0
            .lock()
            .expect("appendable reader")
            .bytes
            .extend_from_slice(&delimit(&[frame]));
    }
}

impl Read for AppendableReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let mut state = self.0.lock().expect("appendable reader");
        let available = state.bytes.len().saturating_sub(state.offset);
        let count = available.min(buffer.len());
        if count == 0 {
            return Ok(0);
        }
        buffer[..count].copy_from_slice(&state.bytes[state.offset..state.offset + count]);
        state.offset += count;
        drop(state);
        Ok(count)
    }
}

pub(super) fn established(
    launch_frames: Vec<Vec<u8>>,
    writer: TestWriter,
) -> SupervisorManagementChannel<Cursor<Vec<u8>>, TestWriter> {
    established_with_maximum_in_flight(launch_frames, writer, 16)
}

pub(super) fn established_with_maximum_in_flight(
    launch_frames: Vec<Vec<u8>>,
    writer: TestWriter,
    maximum_in_flight_frames: u64,
) -> SupervisorManagementChannel<Cursor<Vec<u8>>, TestWriter> {
    established_from_reader(
        Cursor::new(input_bytes(launch_frames, maximum_in_flight_frames)),
        writer,
    )
}

pub(super) fn established_appendable(
    launch_frames: Vec<Vec<u8>>,
    writer: TestWriter,
    maximum_in_flight_frames: u64,
) -> (
    SupervisorManagementChannel<AppendableReader, TestWriter>,
    AppendableReader,
) {
    let reader = AppendableReader::new(input_bytes(launch_frames, maximum_in_flight_frames));
    let append = reader.clone();
    (established_from_reader(reader, writer), append)
}

pub(super) fn established_from_reader<R: Read>(
    reader: R,
    writer: TestWriter,
) -> SupervisorManagementChannel<R, TestWriter> {
    let mut bootstrap = SupervisorManagementBootstrap::new(
        reader,
        writer,
        ConnectionId::new(CONNECTION).expect("connection"),
        TOKEN.to_vec(),
        fixtures::launch_receipt(),
    )
    .expect("bootstrap");
    bootstrap.receive_host_hello().expect("host hello");
    bootstrap.send_supervisor_hello().expect("supervisor hello");
    bootstrap
        .into_established(ManagementReplayLimits::new(16, 64, 512 * 1024).expect("replay limits"))
        .expect("established")
}

pub(super) fn launch_frame(
    launch: wire::LaunchAttemptProcess,
    message_id: &str,
    stream_seq: u64,
) -> Vec<u8> {
    frame(
        wire::management_payload::Body::LaunchAttemptProcess(launch),
        message_id,
        stream_seq,
    )
}

pub(super) fn decoded_bodies(writer: &TestWriter) -> Vec<wire::management_payload::Body> {
    decoded_frames(writer)
        .into_iter()
        .map(|encoded| {
            let mut validated = validate_management_frame(&encoded).expect("valid output frame");
            validated.payload.body.take().expect("output body")
        })
        .collect()
}

pub(super) fn decoded_frames(writer: &TestWriter) -> Vec<Vec<u8>> {
    let codec = DelimitedFrameCodec::new(
        u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management frame cap"),
    )
    .expect("codec");
    let mut cursor = Cursor::new(writer.bytes());
    let mut frames = Vec::new();
    while let Some(encoded) = codec.read_raw(&mut cursor).expect("output frame") {
        frames.push(encoded);
    }
    frames
}

pub(super) fn output_sent_at_unix_ms(writer: &TestWriter, output_index: usize) -> i64 {
    let codec = DelimitedFrameCodec::new(
        u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management frame cap"),
    )
    .expect("codec");
    let mut cursor = Cursor::new(writer.bytes());
    for index in 0..=output_index {
        let encoded = codec
            .read_raw(&mut cursor)
            .expect("output frame")
            .expect("output index");
        if index == output_index {
            return validate_management_frame(&encoded)
                .expect("valid output frame")
                .frame
                .header
                .as_ref()
                .expect("output header")
                .sent_at_unix_ms;
        }
    }
    unreachable!("bounded output index loop returns at its final iteration")
}

fn input_bytes(mut frames: Vec<Vec<u8>>, maximum_in_flight_frames: u64) -> Vec<u8> {
    frames.insert(
        0,
        frame(
            wire::management_payload::Body::HostSupervisorHello(
                fixtures::host_hello_with_maximum_in_flight(maximum_in_flight_frames),
            ),
            "host-bootstrap",
            1,
        ),
    );
    delimit(&frames)
}

pub(super) fn frame(
    body: wire::management_payload::Body,
    message_id: &str,
    stream_seq: u64,
) -> Vec<u8> {
    frame_with_reply(body, message_id, stream_seq, 90, None)
}

pub(super) fn frame_with_reply(
    body: wire::management_payload::Body,
    message_id: &str,
    stream_seq: u64,
    sent_at_unix_ms: i64,
    reply_to_message_id: Option<String>,
) -> Vec<u8> {
    encode_management_frame(
        wire::ManagementFrameHeader {
            protocol_version: ProtocolVersion::new(1, 1).to_wire(),
            connection_id: CONNECTION.into(),
            message_id: message_id.into(),
            reply_to_message_id,
            stream_seq,
            sent_at_unix_ms,
            ..wire::ManagementFrameHeader::default()
        },
        &wire::ManagementPayload { body: Some(body) },
    )
    .expect("frame")
}

pub(super) fn delimit(frames: &[Vec<u8>]) -> Vec<u8> {
    let codec = DelimitedFrameCodec::new(
        u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management frame cap"),
    )
    .expect("codec");
    let mut bytes = Vec::new();
    for frame in frames {
        codec.write_raw(&mut bytes, frame).expect("delimit");
    }
    bytes
}
