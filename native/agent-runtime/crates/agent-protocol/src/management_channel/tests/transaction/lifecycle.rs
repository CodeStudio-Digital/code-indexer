use super::*;

#[test]
fn equality_with_deadline_is_expired() {
    let inbound = frame_with_context(
        wire::management_payload::Body::LaunchAccepted(wire::LaunchAccepted::default()),
        "deadline",
        2,
        protocol(),
        CONNECTION,
        Some(NOW + 10),
    );
    let mut channel = host_channel(vec![inbound], RecordingWriter::default(), limits());

    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 10),
        Err(ManagementChannelError::DeadlineExpired {
            deadline_at,
            observed_at
        }) if deadline_at == observed_at
    ));
}

#[test]
fn response_write_failure_poisoned_channel_returns_no_receipt() {
    let mut channel = host_channel(vec![event("event", 2)], FailWriter::new(3), limits());
    let inbound = pending(
        channel
            .begin_receive_with_clock(|| NOW + 2)
            .expect("inbound"),
    );
    let response = ack_for(&inbound);
    let error = channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 3)
        .expect_err("write must fail");

    assert!(matches!(error, ManagementChannelError::Framing(_)));
    assert!(channel.is_poisoned());
}

#[test]
fn poison_eagerly_releases_pending_history_replay_and_sender_reservation() {
    let mut replay_channel = host_channel(
        vec![event("cached", 2)],
        RecordingWriter::default(),
        limits(),
    );
    let inbound = pending(
        replay_channel
            .begin_receive_with_clock(|| NOW + 2)
            .expect("cached inbound"),
    );
    let response = ack_for(&inbound);
    replay_channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 3)
        .expect("cached response");
    let (_, active, tombstones, replay_bytes, sender_pending, _, _) =
        replay_channel.retained_state();
    assert_eq!((active, tombstones), (1, 1));
    assert!(replay_bytes > 0);
    assert!(!sender_pending);

    assert!(matches!(
        replay_channel.begin_receive_with_clock(|| NOW + 4),
        Err(ManagementChannelError::UnexpectedEof)
    ));
    assert_eq!(
        replay_channel.retained_state(),
        (false, 0, 0, 0, false, 0, 0)
    );

    let launch =
        super::super::support::payload(wire::management_payload::Body::LaunchAttemptProcess(
            super::super::support::launch_attempt(),
        ));
    let mut write_failure = host_channel(Vec::new(), FailWriter::new(3), limits());
    assert!(matches!(
        write_failure.send_new_with_clock(&launch, deadline(50), || NOW + 2),
        Err(ManagementChannelError::Framing(_))
    ));
    assert_eq!(
        write_failure.retained_state(),
        (false, 0, 0, 0, false, 0, 0)
    );
}
