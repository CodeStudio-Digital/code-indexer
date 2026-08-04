use tokio::io::{AsyncReadExt, AsyncWriteExt, duplex};
use tokio::time::{Duration, Instant};

use super::support::{TEST_TIMEOUT, management_channel};
use crate::framing::asynchronous::{AsyncFramingError, IdleReceiveOutcome};

#[tokio::test(start_paused = true)]
async fn idle_wake_restores_stream_for_the_next_frame() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);

    let outcome = channel
        .receive_until_idle_wake(
            Instant::now() + TEST_TIMEOUT,
            Instant::now() + Duration::from_secs(30),
            TEST_TIMEOUT,
        )
        .await
        .expect("idle wake");
    assert!(matches!(outcome, IdleReceiveOutcome::Idle));
    assert!(!channel.is_poisoned());

    peer.write_all(&[1, 0x7f]).await.expect("complete frame");
    let outcome = channel
        .receive_until_idle_wake(
            Instant::now() + TEST_TIMEOUT,
            Instant::now() + Duration::from_secs(30),
            TEST_TIMEOUT,
        )
        .await
        .expect("frame after idle wake");
    let IdleReceiveOutcome::Frame(frame) = outcome else {
        panic!("frame expected after idle wake");
    };
    assert_eq!(frame, vec![0x7f]);
    assert!(!channel.is_poisoned());
}

#[tokio::test(start_paused = true)]
async fn idle_wait_outlives_progress_timeout_until_cancelled() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);
    let mut receive = Box::pin(
        channel
            .receive_idle_progress_bounded(Instant::now() + Duration::from_secs(30), TEST_TIMEOUT),
    );

    tokio::select! {
        biased;
        result = &mut receive => panic!("idle read completed: {result:?}"),
        () = tokio::time::sleep(TEST_TIMEOUT * 4) => {}
    }
    drop(receive);

    assert!(channel.is_poisoned());
    let mut byte = [0_u8; 1];
    assert_eq!(peer.read(&mut byte).await.expect("peer EOF"), 0);
}

#[tokio::test(start_paused = true)]
async fn partial_frame_stalls_only_for_progress_timeout() {
    let (local, mut peer) = duplex(64);
    let mut channel = management_channel(local);
    peer.write_all(&[0x80]).await.expect("partial prefix");

    let error = channel
        .receive_idle_progress_bounded(Instant::now() + Duration::from_secs(30), TEST_TIMEOUT)
        .await
        .expect_err("partial frame timeout");

    assert!(matches!(error, AsyncFramingError::ReadDeadlineElapsed));
    assert!(channel.is_poisoned());
}

#[tokio::test(start_paused = true)]
async fn hard_deadline_bounds_idle_and_prebuffered_frames() {
    let (idle_local, _idle_peer) = duplex(64);
    let mut idle = management_channel(idle_local);
    let error = idle
        .receive_idle_progress_bounded(Instant::now() + TEST_TIMEOUT, Duration::from_secs(30))
        .await
        .expect_err("idle hard deadline");
    assert!(matches!(error, AsyncFramingError::ReadDeadlineElapsed));

    let (ready_local, mut ready_peer) = duplex(64);
    let mut ready = management_channel(ready_local);
    ready_peer
        .write_all(&[1, 0x7f])
        .await
        .expect("prebuffered frame");
    let error = ready
        .receive_idle_progress_bounded(Instant::now(), Duration::from_secs(30))
        .await
        .expect_err("expired hard deadline");
    assert!(matches!(error, AsyncFramingError::ReadDeadlineElapsed));
    assert!(ready.is_poisoned());
}
