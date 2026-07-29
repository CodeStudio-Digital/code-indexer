use super::*;

#[test]
fn new_request_then_correlated_response_owns_sequence_and_reply_binding() {
    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    let launch = super::super::support::payload(
        wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
    );
    let sent = channel
        .send_new_with_clock(&launch, deadline(50), || NOW + 2)
        .expect("new launch");
    assert_eq!(sent.stream_seq(), 2);
    let sent_frames = decode_delimited(&writer.bytes());
    let (launch_header, _) = decode_frame(&sent_frames[1]);
    let accepted = frame_with_reply(
        wire::management_payload::Body::LaunchAccepted(launch_accepted()),
        "accepted-after-launch",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(&launch_header.message_id),
    );
    reader.append(&delimited(&[accepted]));

    let inbound = pending(
        channel
            .begin_receive_with_clock(|| NOW + 3)
            .expect("accepted"),
    );
    let response = ack_for(&inbound);
    channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 4)
        .expect("ack response");

    let output = decode_delimited(&writer.bytes());
    assert_eq!(output.len(), 3);
    let (ack_header, _) = decode_frame(&output[2]);
    assert_eq!(launch_header.stream_seq, 2);
    assert!(launch_header.reply_to_message_id.is_none());
    assert_eq!(
        launch_header.deadline_at_unix_ms,
        Some(launch_header.sent_at_unix_ms + 50)
    );
    assert_eq!(ack_header.stream_seq, 3);
    assert_eq!(
        ack_header.reply_to_message_id.as_deref(),
        Some("accepted-after-launch")
    );
}

#[test]
fn relative_deadline_cannot_exceed_the_sealed_write_timeout() {
    let launch = super::super::support::payload(
        wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
    );
    let mut channel = host_channel(Vec::new(), RecordingWriter::default(), limits());

    assert!(matches!(
        channel.send_new_with_clock(&launch, deadline(10_001), || NOW + 2),
        Err(ManagementChannelError::InvalidDeadlinePolicy {
            timeout_ms: 10_001,
            maximum: 10_000
        })
    ));
    assert!(channel.is_poisoned());
}

#[test]
fn caller_cannot_choose_response_only_payload_for_new_or_event_for_response() {
    let response_only = super::super::support::payload(
        wire::management_payload::Body::LaunchAccepted(launch_accepted()),
    );
    let mut new_channel = host_channel(Vec::new(), RecordingWriter::default(), limits());
    assert!(matches!(
        new_channel.send_new_with_clock(&response_only, deadline(50), || NOW + 2),
        Err(ManagementChannelError::PayloadNotAllowed { .. })
    ));
    assert!(new_channel.is_poisoned());

    let mut response_channel = host_channel(
        vec![event("event", 2)],
        RecordingWriter::default(),
        limits(),
    );
    let inbound = pending(
        response_channel
            .begin_receive_with_clock(|| NOW + 2)
            .expect("accepted"),
    );
    let event = super::super::support::payload(
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + 3,
            ..wire::SupervisorResourceSample::default()
        }),
    );
    assert!(matches!(
        response_channel.commit_response_with_clock(*inbound, &event, deadline(50), || NOW + 3),
        Err(ManagementChannelError::InvalidResponseCorrelation { .. })
    ));
    assert!(response_channel.is_poisoned());
}

#[test]
fn response_to_later_outstanding_message_fails_fifo_closed() {
    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    let query = super::super::support::payload(
        wire::management_payload::Body::QuerySupervisorState(wire::QuerySupervisorState::default()),
    );
    channel
        .send_new_with_clock(&query, deadline(50), || NOW + 2)
        .expect("first query");
    channel
        .send_new_with_clock(&query, deadline(50), || NOW + 3)
        .expect("second query");
    let output = decode_delimited(&writer.bytes());
    let (second, _) = decode_frame(&output[2]);
    let response = frame_with_reply(
        wire::management_payload::Body::SupervisorState(wire::SupervisorState {
            connection_id: CONNECTION.into(),
            observed_at_unix_ms: NOW + 4,
            ..wire::SupervisorState::default()
        }),
        "second-response-first",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(&second.message_id),
    );
    reader.append(&delimited(&[response]));

    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 4),
        Err(ManagementChannelError::OutOfOrderResponse)
    ));
    assert!(channel.is_poisoned());
}
