use std::time::Duration;

use prost::Message;
use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::time::Instant;

use super::*;
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;

const TEST_REPLAY_BYTES: usize = CONTROL_FRAME_MAX_BYTES * 4;

fn established() -> (AsyncEstablishedAttemptChannel<DuplexStream>, DuplexStream) {
    established_for(
        FrameDirection::HostToRunner,
        wire::TransportChannel::Control,
    )
}

fn established_for(
    direction: FrameDirection,
    channel: wire::TransportChannel,
) -> (AsyncEstablishedAttemptChannel<DuplexStream>, DuplexStream) {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap fits u32");
    let (local, peer) = duplex(16 * 1024);
    let transport =
        AsyncDelimitedFrameChannel::new(DelimitedFrameCodec::new(maximum).expect("codec"), local);
    let receiver = AttemptFrameReceiver::from_seed(
        authority_tests::seed_for_channel(direction, CONTROL_FRAME_MAX_BYTES, channel),
        2,
        8,
        TEST_REPLAY_BYTES,
    )
    .expect("receiver");
    let sender = receiver.outbound_authority(1).expect("outbound authority");
    (
        AsyncEstablishedAttemptChannel::from_handoff(transport, receiver, sender)
            .expect("established channel"),
        peer,
    )
}

#[tokio::test]
async fn committed_unsolicited_write_returns_exact_correlation_receipt() {
    let (mut channel, peer) =
        established_for(FrameDirection::HostToRunner, wire::TransportChannel::Data);
    let payload = wire::FramePayload {
        body: Some(wire::frame_payload::Body::ProviderStart(
            wire::ProviderStart {
                identity: Some(wire_identity()),
                operation_id: "provider-operation/1".into(),
                binding: Some(wire::ProviderBinding {
                    effective_provider: "fixture".into(),
                    effective_model: "fixture-model".into(),
                    ..wire::ProviderBinding::default()
                }),
                deadline_at_unix_ms: 100,
                idempotency_key: "provider-start/1".into(),
                ..wire::ProviderStart::default()
            },
        )),
    };
    let receipt = channel
        .send_new(&payload, 100, Instant::now() + Duration::from_secs(1), || 2)
        .await
        .expect("committed write");
    let mut peer = AsyncDelimitedFrameChannel::new(
        DelimitedFrameCodec::new(u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("cap"))
            .expect("codec"),
        peer,
    );
    let encoded = peer
        .receive(Instant::now() + Duration::from_secs(1))
        .await
        .expect("wire frame");
    let frame = wire::Frame::decode(encoded.as_slice()).expect("decode frame");

    assert_eq!(
        receipt.message_id(),
        frame.header.as_ref().expect("header").message_id
    );
    assert_eq!(receipt.stream_seq(), 2);
    assert_eq!(receipt.sent_at_unix_ms(), 2);
    assert_eq!(
        receipt.payload_digest(),
        &frame_payload_sha256(&payload.encode_to_vec()),
    );
}

async fn assert_peer_closed(peer: &mut DuplexStream) {
    let mut byte = [0_u8; 1];
    assert_eq!(
        peer.read(&mut byte).await.expect("peer EOF"),
        0,
        "dropping an unpolled operation must close its physical stream",
    );
}

#[tokio::test]
async fn never_polled_begin_receive_poisons_owner_and_closes_peer() {
    let (mut channel, mut peer) = established();
    let future = channel.begin_receive(
        Instant::now() + Duration::from_secs(1),
        Instant::now() + Duration::from_secs(1),
        Duration::from_millis(50),
        || 2,
    );

    drop(future);

    assert!(channel.is_poisoned());
    assert_peer_closed(&mut peer).await;
}

#[tokio::test]
async fn never_polled_commit_response_poisons_without_writing() {
    let (mut channel, mut peer) = established();
    let inbound = authority_tests::bytes_with(
        wire::frame_payload::Body::Ack(wire::Ack::default()),
        "message-2",
        2,
    );
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap fits u32");
    let mut delimited = Vec::new();
    DelimitedFrameCodec::new(maximum)
        .expect("codec")
        .write_raw(&mut delimited, &inbound)
        .expect("framing");
    peer.write_all(&delimited).await.expect("write inbound");
    let FrameReceiveOutcome::Pending(pending) = channel
        .begin_receive(
            Instant::now() + Duration::from_secs(1),
            Instant::now() + Duration::from_secs(1),
            Duration::from_millis(50),
            || 2,
        )
        .await
        .expect("pending")
    else {
        panic!("expected pending inbound");
    };
    let response = authority_tests::prepared_payload();
    let future = channel.commit_response(
        *pending,
        &response,
        10,
        Instant::now() + Duration::from_secs(1),
        || 2,
    );

    drop(future);

    assert!(channel.is_poisoned());
    assert_peer_closed(&mut peer).await;
}
