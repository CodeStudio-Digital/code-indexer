use tokio::io::{DuplexStream, duplex};

use super::bootstrap::NegotiatedReceiverSeed;
use super::{
    AsyncEstablishedAttemptChannel, AttemptFrameReceiver, DATA_FRAME_MAX_BYTES, FrameDirection,
};
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId};
use crate::version::ProtocolVersion;
use crate::wire_identity::identity_from_wire;

const TEST_REPLAY_ENTRIES: usize = 8;
const TEST_TRACKED_MESSAGES: usize = 64;

/// Creates opposite single-owner Data peers without bypassing frame validators.
///
/// This surface is compiled only with `testing`; product code must acquire
/// established channels through the authenticated bootstrap typestates.
#[must_use]
pub fn established_data_duplex(
    identity: &wire::AttemptIdentity,
) -> Option<(
    AsyncEstablishedAttemptChannel<DuplexStream>,
    AsyncEstablishedAttemptChannel<DuplexStream>,
)> {
    let identity = identity_from_wire(identity).ok()?;
    let connection = ConnectionId::new("test-provider-data").ok()?;
    let replay_bytes = DATA_FRAME_MAX_BYTES.checked_mul(TEST_REPLAY_ENTRIES)?;
    let (runner_stream, host_stream) = duplex(DATA_FRAME_MAX_BYTES * 2);
    Some((
        endpoint(
            runner_stream,
            identity.clone(),
            connection.clone(),
            FrameDirection::HostToRunner,
            replay_bytes,
        )?,
        endpoint(
            host_stream,
            identity,
            connection,
            FrameDirection::RunnerToHost,
            replay_bytes,
        )?,
    ))
}

fn endpoint(
    stream: DuplexStream,
    identity: AttemptIdentity,
    connection: ConnectionId,
    direction: FrameDirection,
    replay_bytes: usize,
) -> Option<AsyncEstablishedAttemptChannel<DuplexStream>> {
    let seed = NegotiatedReceiverSeed {
        protocol: ProtocolVersion::new(1, 1),
        connection,
        identity,
        channel: wire::TransportChannel::Data,
        direction,
        maximum_frame_bytes: DATA_FRAME_MAX_BYTES,
        stream_watermark: 1,
        bootstrap_message_id: "test-bootstrap".into(),
        bootstrap_channel_id: 1,
    };
    let receiver = AttemptFrameReceiver::from_seed(
        seed,
        TEST_REPLAY_ENTRIES,
        TEST_TRACKED_MESSAGES,
        replay_bytes,
    )
    .ok()?;
    let sender = receiver.outbound_authority(1).ok()?;
    let maximum = u32::try_from(DATA_FRAME_MAX_BYTES).ok()?;
    let transport =
        AsyncDelimitedFrameChannel::new(DelimitedFrameCodec::new(maximum).ok()?, stream);
    AsyncEstablishedAttemptChannel::from_handoff(transport, receiver, sender).ok()
}
