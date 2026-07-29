use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream, duplex};
use tokio::time::Instant;

use super::*;
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::AsyncDelimitedFrameChannel;

const TEST_REPLAY_BYTES: usize = CONTROL_FRAME_MAX_BYTES * 4;

fn established() -> (AsyncEstablishedAttemptChannel<DuplexStream>, DuplexStream) {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap fits u32");
    let (local, peer) = duplex(16 * 1024);
    let transport =
        AsyncDelimitedFrameChannel::new(DelimitedFrameCodec::new(maximum).expect("codec"), local);
    let receiver = AttemptFrameReceiver::from_seed(
        authority_tests::seed(FrameDirection::HostToRunner, CONTROL_FRAME_MAX_BYTES),
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
