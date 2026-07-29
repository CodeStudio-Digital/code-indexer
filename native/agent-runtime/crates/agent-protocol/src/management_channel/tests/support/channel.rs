use std::io::{self, Cursor, Read, Write};
use std::sync::{Arc, Mutex};

use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use crate::generated::v1 as wire;
use crate::management_channel::{
    BootstrapManagementChannel, EstablishedManagementChannel, ManagementDirection,
    ManagementReplayLimits,
};

use super::fixtures::{
    MANAGEMENT_TOKEN, NOW, SUPERVISOR_NONCE, connection, hard_cap_u32, host_hello, supervisor_hello,
};
use super::wire::{delimited, frame, supervisor_bootstrap_frame};

pub fn host_channel<W: Write>(
    inbound: Vec<Vec<u8>>,
    writer: W,
    replay_limits: ManagementReplayLimits,
) -> EstablishedManagementChannel<Cursor<Vec<u8>>, W> {
    host_channel_with_hello(inbound, writer, replay_limits, &host_hello())
}

pub fn host_channel_with_hello<W: Write>(
    inbound: Vec<Vec<u8>>,
    writer: W,
    replay_limits: ManagementReplayLimits,
    hello: &wire::HostSupervisorHello,
) -> EstablishedManagementChannel<Cursor<Vec<u8>>, W> {
    let mut frames = vec![supervisor_bootstrap_frame()];
    frames.extend(inbound);
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    let transport = DelimitedFrameChannel::new(codec, Cursor::new(delimited(&frames)), writer);
    let mut bootstrap = BootstrapManagementChannel::new(
        transport,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
        ManagementDirection::SupervisorToHost,
    )
    .expect("bootstrap");
    bootstrap
        .send_host_hello_with_clock(hello, || NOW)
        .expect("host hello");
    bootstrap
        .receive_with_clock(|| NOW + 1)
        .expect("supervisor hello");
    bootstrap.into_established(replay_limits).expect("handoff")
}

pub fn supervisor_channel<W: Write>(
    inbound: Vec<Vec<u8>>,
    writer: W,
    replay_limits: ManagementReplayLimits,
) -> EstablishedManagementChannel<Cursor<Vec<u8>>, W> {
    let mut frames = vec![frame(
        wire::management_payload::Body::HostSupervisorHello(host_hello()),
        "host-bootstrap",
        1,
    )];
    frames.extend(inbound);
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    let transport = DelimitedFrameChannel::new(codec, Cursor::new(delimited(&frames)), writer);
    let mut bootstrap = BootstrapManagementChannel::new(
        transport,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
        ManagementDirection::HostToSupervisor,
    )
    .expect("bootstrap");
    bootstrap.receive_with_clock(|| NOW).expect("host hello");
    bootstrap
        .send_supervisor_hello_with_clock(&supervisor_hello(), || NOW + 1)
        .expect("supervisor hello");
    bootstrap.into_established(replay_limits).expect("handoff")
}

#[derive(Clone, Debug, Default)]
pub struct AppendableReader {
    state: Arc<Mutex<AppendableReaderState>>,
}

#[derive(Debug, Default)]
struct AppendableReaderState {
    bytes: Vec<u8>,
    position: usize,
}

impl AppendableReader {
    pub fn append(&self, bytes: &[u8]) {
        self.state
            .lock()
            .expect("appendable reader lock")
            .bytes
            .extend_from_slice(bytes);
    }
}

impl Read for AppendableReader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        let mut state = self.state.lock().expect("appendable reader lock");
        let remaining = &state.bytes[state.position..];
        let length = remaining.len().min(output.len());
        output[..length].copy_from_slice(&remaining[..length]);
        state.position += length;
        drop(state);
        Ok(length)
    }
}

pub fn appendable_host_channel<W: Write>(
    writer: W,
    replay_limits: ManagementReplayLimits,
) -> (
    EstablishedManagementChannel<AppendableReader, W>,
    AppendableReader,
) {
    let reader = AppendableReader::default();
    reader.append(&delimited(&[supervisor_bootstrap_frame()]));
    let codec = DelimitedFrameCodec::new(hard_cap_u32()).expect("codec");
    let transport = DelimitedFrameChannel::new(codec, reader.clone(), writer);
    let mut bootstrap = BootstrapManagementChannel::new(
        transport,
        connection(),
        SUPERVISOR_NONCE.to_vec(),
        MANAGEMENT_TOKEN.to_vec(),
        ManagementDirection::SupervisorToHost,
    )
    .expect("bootstrap");
    bootstrap
        .send_host_hello_with_clock(&host_hello(), || NOW)
        .expect("host hello");
    bootstrap
        .receive_with_clock(|| NOW + 1)
        .expect("supervisor hello");
    (
        bootstrap.into_established(replay_limits).expect("handoff"),
        reader,
    )
}
