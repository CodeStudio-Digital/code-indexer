use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
use tokio::time::Instant;

use super::AsyncFramingError;
use crate::framing::{FramingError, encode_length};
use crate::management_frame::MANAGEMENT_FRAME_MAX_BYTES;

use self::support::{assert_permanently_poisoned, deadline, management_channel};

#[tokio::test]
async fn round_trip_preserves_exact_frame_bytes() {
    let (left, right) = duplex(128);
    let mut sender = management_channel(left);
    let mut receiver = management_channel(right);
    let frame = b"bounded-management-frame";

    sender.send(frame, deadline()).await.expect("send");
    let received_frame = receiver.receive(deadline()).await.expect("receive");

    assert_eq!(received_frame, frame);
    assert!(!sender.is_poisoned());
    assert!(!receiver.is_poisoned());
}

#[tokio::test]
async fn expired_deadline_rejects_prebuffered_read_before_polling_io() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);
    peer.write_all(&[1, 0x7f]).await.expect("prebuffer frame");

    let error = channel
        .receive(Instant::now())
        .await
        .expect_err("expired read");

    assert!(matches!(error, AsyncFramingError::ReadDeadlineElapsed));
    assert_permanently_poisoned(&mut channel).await;
}

#[tokio::test]
async fn expired_deadline_rejects_ready_write_before_polling_io() {
    let (local, _peer) = duplex(64);
    let mut channel = management_channel(local);

    let error = channel
        .send(b"would-fit", Instant::now())
        .await
        .expect_err("expired write");

    assert!(matches!(error, AsyncFramingError::WriteDeadlineElapsed));
    assert_permanently_poisoned(&mut channel).await;
}

#[tokio::test(start_paused = true)]
async fn silent_peer_hits_read_deadline_and_closes_permanently() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);

    let error = channel.receive(deadline()).await.expect_err("timeout");
    assert!(matches!(error, AsyncFramingError::ReadDeadlineElapsed));
    assert_permanently_poisoned(&mut channel).await;

    let mut byte = [0_u8; 1];
    assert_eq!(peer.read(&mut byte).await.expect("peer observes close"), 0);
}

#[tokio::test(start_paused = true)]
async fn backpressure_hits_write_deadline_after_partial_write() {
    let (local, _silent_peer) = duplex(4);
    let mut channel = management_channel(local);
    let frame = [0x5a_u8; 128];

    let error = channel
        .send(&frame, deadline())
        .await
        .expect_err("write timeout");

    assert!(matches!(error, AsyncFramingError::WriteDeadlineElapsed));
    assert_permanently_poisoned(&mut channel).await;
}

#[tokio::test(start_paused = true)]
async fn cancellation_after_first_poll_drops_stream_and_poisons_owner() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);
    let mut pending = Box::pin(channel.receive(Instant::now() + Duration::from_secs(30)));

    tokio::select! {
        biased;
        result = &mut pending => panic!("receive unexpectedly completed: {result:?}"),
        () = tokio::task::yield_now() => {}
    }
    drop(pending);

    assert_permanently_poisoned(&mut channel).await;
    let mut byte = [0_u8; 1];
    assert_eq!(peer.read(&mut byte).await.expect("peer observes close"), 0);
}

#[tokio::test]
async fn partial_prefix_and_body_fail_closed() {
    let (prefix_local, mut prefix_peer) = duplex(64);
    let mut prefix_channel = management_channel(prefix_local);
    prefix_peer
        .write_all(&[0x80])
        .await
        .expect("partial prefix");
    drop(prefix_peer);

    let prefix_error = prefix_channel
        .receive(deadline())
        .await
        .expect_err("truncated prefix");
    assert!(matches!(
        prefix_error,
        AsyncFramingError::Framing(FramingError::TruncatedLength)
    ));
    assert_permanently_poisoned(&mut prefix_channel).await;

    let (body_local, mut body_peer) = duplex(64);
    let mut body_channel = management_channel(body_local);
    body_peer
        .write_all(&[4, 0xaa, 0xbb])
        .await
        .expect("partial body");
    drop(body_peer);

    let body_error = body_channel
        .receive(deadline())
        .await
        .expect_err("truncated body");
    assert!(matches!(
        body_error,
        AsyncFramingError::Framing(FramingError::TruncatedFrame { declared: 4 })
    ));
    assert_permanently_poisoned(&mut body_channel).await;
}

#[tokio::test]
async fn oversized_inbound_length_is_rejected_before_allocation() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);
    let declared = u32::try_from(MANAGEMENT_FRAME_MAX_BYTES + 1).expect("oversize fits u32");
    let (prefix, prefix_length) = encode_length(declared);
    peer.write_all(&prefix[..prefix_length])
        .await
        .expect("length prefix");

    let error = channel
        .receive(deadline())
        .await
        .expect_err("oversized frame");

    let maximum = u32::try_from(MANAGEMENT_FRAME_MAX_BYTES).expect("management cap fits u32");
    assert!(matches!(
        error,
        AsyncFramingError::Framing(FramingError::FrameTooLarge {
            declared: actual,
            maximum: actual_maximum
        }) if actual == declared && actual_maximum == maximum
    ));
    assert_permanently_poisoned(&mut channel).await;
}

#[tokio::test]
async fn consuming_handoff_keeps_same_stream_and_narrows_cap() {
    let (left, right) = duplex(128);
    let mut host_bootstrap = management_channel(left);
    let mut supervisor_bootstrap = management_channel(right);

    host_bootstrap
        .send(b"host-hello", deadline())
        .await
        .expect("bootstrap send");
    assert_eq!(
        supervisor_bootstrap
            .receive(deadline())
            .await
            .expect("bootstrap receive"),
        b"host-hello"
    );

    let mut host_established = host_bootstrap.narrow(32).expect("host handoff");
    let mut supervisor_established = supervisor_bootstrap.narrow(32).expect("supervisor handoff");
    assert_eq!(host_established.maximum_frame_bytes(), 32);
    assert_eq!(supervisor_established.maximum_frame_bytes(), 32);

    supervisor_established
        .send(b"launch-accepted", deadline())
        .await
        .expect("established send");
    assert_eq!(
        host_established
            .receive(deadline())
            .await
            .expect("established receive"),
        b"launch-accepted"
    );
}

#[tokio::test]
async fn narrowing_cannot_widen_and_new_cap_is_enforced() {
    let (local, _peer) = duplex(128);
    let channel = management_channel(local);
    let current = channel.maximum_frame_bytes();
    let widening_error = channel.narrow(current + 1).expect_err("widening");
    assert!(matches!(
        widening_error,
        AsyncFramingError::Framing(FramingError::FrameTooLarge {
            declared,
            maximum
        }) if declared == current + 1 && maximum == current
    ));

    let (local, _peer) = duplex(128);
    let mut narrowed = management_channel(local).narrow(8).expect("narrowing");
    let error = narrowed
        .send(&[0_u8; 9], deadline())
        .await
        .expect_err("narrow cap");
    assert!(matches!(
        error,
        AsyncFramingError::Framing(FramingError::FrameTooLarge {
            declared: 9,
            maximum: 8
        })
    ));
    assert_permanently_poisoned(&mut narrowed).await;
}

mod idle;
mod support;
