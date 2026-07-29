use super::*;

#[test]
fn outstanding_frame_and_byte_budgets_are_sealed_and_poison_releases_them() {
    let mut one_frame = host_hello();
    one_frame
        .frame_limits
        .as_mut()
        .expect("frame limits")
        .max_in_flight_frames = 1;
    let mut channel =
        host_channel_with_hello(Vec::new(), RecordingWriter::default(), limits(), &one_frame);
    let update = super::super::support::payload(
        wire::management_payload::Body::UpdateAttemptAuthority(update_authority()),
    );
    channel
        .send_new_with_clock(&update, deadline(50), || NOW + 2)
        .expect("first outstanding");
    let state = channel.retained_state();
    assert_eq!(state.5, 1);
    assert!(state.6 > 0);
    assert!(matches!(
        channel.send_new_with_clock(&update, deadline(50), || NOW + 3),
        Err(ManagementChannelError::OutstandingCapacityExhausted { .. })
    ));
    assert_eq!(channel.retained_state(), (false, 0, 0, 0, false, 0, 0));

    let mut byte_limited = host_hello();
    let frame_limits = byte_limited.frame_limits.as_mut().expect("frame limits");
    frame_limits.max_frame_bytes = 1_024;
    frame_limits.max_chunk_bytes = 1_024;
    frame_limits.max_in_flight_frames = 32;
    frame_limits.max_in_flight_bytes = 1_024;
    let mut channel = host_channel_with_hello(
        Vec::new(),
        RecordingWriter::default(),
        limits(),
        &byte_limited,
    );
    let mut successful = 0;
    loop {
        match channel.send_new_with_clock(&update, deadline(50), || NOW + 2 + successful) {
            Ok(_) => {
                successful += 1;
                let state = channel.retained_state();
                assert!(state.6 <= 1_024);
            }
            Err(ManagementChannelError::OutstandingCapacityExhausted {
                bytes,
                maximum_bytes,
                ..
            }) => {
                assert!(bytes > maximum_bytes);
                break;
            }
            Err(error) => panic!("unexpected bounded send error: {error}"),
        }
    }
    assert!(successful > 0);
    assert!(channel.is_poisoned());
    assert_eq!(channel.retained_state(), (false, 0, 0, 0, false, 0, 0));
}

#[test]
fn correlation_is_consumed_only_when_the_inbound_transaction_commits() {
    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    let launch = super::super::support::payload(
        wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
    );
    channel
        .send_new_with_clock(&launch, deadline(50), || NOW + 2)
        .expect("launch");
    let (header, _) = decode_frame(&decode_delimited(&writer.bytes())[1]);
    reader.append(&delimited(&[frame_with_reply(
        wire::management_payload::Body::LaunchAccepted(launch_accepted()),
        "accepted",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(&header.message_id),
    )]));

    let inbound = pending(
        channel
            .begin_receive_with_clock(|| NOW + 3)
            .expect("accepted"),
    );
    assert_eq!(channel.retained_state().5, 1);
    let response = ack_for(&inbound);
    channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 3)
        .expect("ACK");
    assert_eq!(channel.retained_state().5, 0);
}

#[test]
fn replay_metadata_cannot_pin_an_evicted_response_allocation() {
    let replay_limits =
        crate::management_channel::ManagementReplayLimits::new(1, 4, 64 * 1024).expect("limits");
    let first = event("first", 2);
    let second = event("second", 3);
    let writer = RecordingWriter::default();
    let mut channel = host_channel(
        vec![first.clone(), first, second],
        writer.clone(),
        replay_limits,
    );
    let inbound = pending(channel.begin_receive_with_clock(|| NOW + 2).expect("first"));
    let response = ack_for(&inbound);
    channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 2)
        .expect("first ACK");
    let replay = match channel
        .begin_receive_with_clock(|| NOW + 3)
        .expect("replay")
        .expect("frame")
    {
        ManagementReceiveOutcome::Replay(value) => value,
        ManagementReceiveOutcome::Pending(_) => panic!("expected replay"),
    };
    let retained_metadata = replay.clone();
    assert_eq!(replay.message_id(), retained_metadata.message_id());

    let inbound = pending(
        channel
            .begin_receive_with_clock(|| NOW + 4)
            .expect("second"),
    );
    let response = ack_for(&inbound);
    channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 4)
        .expect("second ACK");
    let output = decode_delimited(&writer.bytes());
    assert_eq!(retained_metadata.message_id(), "first");
    assert_eq!(channel.retained_state().3, output[3].len());
}
