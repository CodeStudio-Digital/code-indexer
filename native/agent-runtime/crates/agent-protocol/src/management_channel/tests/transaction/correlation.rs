use super::*;

type TestChannel = crate::management_channel::EstablishedManagementChannel<
    super::super::support::AppendableReader,
    RecordingWriter,
>;

fn update_channel() -> (
    TestChannel,
    super::super::support::AppendableReader,
    RecordingWriter,
    wire::ManagementFrameHeader,
) {
    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    let update = super::super::support::payload(
        wire::management_payload::Body::UpdateAttemptAuthority(update_authority()),
    );
    channel
        .send_new_with_clock(&update, deadline(50), || NOW + 2)
        .expect("update request");
    let output = decode_delimited(&writer.bytes());
    let (header, _) = decode_frame(&output[1]);
    (channel, reader, writer, header)
}

fn inbound_ack_error(mutate: impl FnOnce(&mut wire::ManagementAck)) -> ManagementChannelError {
    let (mut channel, reader, _, header) = update_channel();
    let mut ack = wire::ManagementAck {
        acknowledged_message_id: header.message_id.clone(),
        acknowledged_payload_sha256: header.payload_sha256.clone(),
        acknowledged_at_unix_ms: NOW + 2,
    };
    mutate(&mut ack);
    let response = frame_with_reply(
        wire::management_payload::Body::ManagementAck(ack),
        "ack",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(&header.message_id),
    );
    reader.append(&delimited(&[response]));
    channel
        .begin_receive_with_clock(|| NOW + 3)
        .expect_err("invalid ACK")
}

#[test]
fn response_requires_a_known_reply_and_new_facts_forbid_one() {
    let missing = frame(
        wire::management_payload::Body::LaunchAccepted(launch_accepted()),
        "missing-reply",
        2,
    );
    let mut channel = host_channel(vec![missing], RecordingWriter::default(), limits());
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::MissingReplyTo { .. })
    ));

    let unknown = frame_with_reply(
        wire::management_payload::Body::LaunchAccepted(launch_accepted()),
        "unknown-reply",
        2,
        protocol(),
        CONNECTION,
        None,
        Some("management:unknown"),
    );
    let mut channel = host_channel(vec![unknown], RecordingWriter::default(), limits());
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::UnknownReplyTo)
    ));

    let with_reply = frame_with_reply(
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + 1,
            ..wire::SupervisorResourceSample::default()
        }),
        "event-with-reply",
        2,
        protocol(),
        CONNECTION,
        None,
        Some("management:any"),
    );
    let mut channel = host_channel(vec![with_reply], RecordingWriter::default(), limits());
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::UnexpectedReplyTo { .. })
    ));
}

#[test]
fn acknowledgements_bind_id_digest_and_owner_clock_window() {
    assert!(matches!(
        inbound_ack_error(|ack| ack.acknowledged_message_id = "forged".into()),
        ManagementChannelError::InvalidAcknowledgement
    ));
    assert!(matches!(
        inbound_ack_error(|ack| ack.acknowledged_payload_sha256 = vec![9; 32]),
        ManagementChannelError::InvalidAcknowledgement
    ));
    assert!(matches!(
        inbound_ack_error(|ack| ack.acknowledged_at_unix_ms = NOW + 1),
        ManagementChannelError::InvalidResponseSemantics { .. }
    ));
    assert!(matches!(
        inbound_ack_error(|ack| ack.acknowledged_at_unix_ms = NOW + 4),
        ManagementChannelError::InvalidManagementPayload { .. }
    ));
}

#[test]
fn outbound_ack_must_bind_the_pending_message_and_clock() {
    let mut channel = host_channel(
        vec![event("event", 2)],
        RecordingWriter::default(),
        limits(),
    );
    let inbound = pending(channel.begin_receive_with_clock(|| NOW + 2).expect("event"));
    let mut response = ack_for(&inbound);
    let Some(wire::management_payload::Body::ManagementAck(ack)) = response.body.as_mut() else {
        panic!("ACK fixture");
    };
    ack.acknowledged_message_id = "forged".into();

    assert!(matches!(
        channel.commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 3),
        Err(ManagementChannelError::InvalidAcknowledgement)
    ));
}

#[test]
fn launch_response_and_state_must_match_the_outstanding_request() {
    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    let launch = super::super::support::payload(
        wire::management_payload::Body::LaunchAttemptProcess(launch_attempt()),
    );
    channel
        .send_new_with_clock(&launch, deadline(50), || NOW + 2)
        .expect("launch");
    let (header, _) = decode_frame(&decode_delimited(&writer.bytes())[1]);
    let mut accepted = launch_accepted();
    accepted.identity.as_mut().expect("identity").attempt_id =
        "99999999-9999-4999-8999-999999999999".into();
    reader.append(&delimited(&[frame_with_reply(
        wire::management_payload::Body::LaunchAccepted(accepted),
        "accepted",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(&header.message_id),
    )]));
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::InvalidResponseSemantics { .. })
    ));

    let writer = RecordingWriter::default();
    let (mut channel, reader) = appendable_host_channel(writer.clone(), limits());
    let query = super::super::support::payload(
        wire::management_payload::Body::QuerySupervisorState(wire::QuerySupervisorState::default()),
    );
    channel
        .send_new_with_clock(&query, deadline(50), || NOW + 2)
        .expect("query");
    let (header, _) = decode_frame(&decode_delimited(&writer.bytes())[1]);
    reader.append(&delimited(&[frame_with_reply(
        wire::management_payload::Body::SupervisorState(wire::SupervisorState {
            connection_id: "management:foreign".into(),
            observed_at_unix_ms: NOW + 2,
            ..wire::SupervisorState::default()
        }),
        "state",
        2,
        protocol(),
        CONNECTION,
        None,
        Some(&header.message_id),
    )]));
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::InvalidManagementPayload { .. })
    ));
}

#[test]
fn future_physical_fact_and_v1_text_smuggling_fail_before_pending() {
    let future = frame(
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + 10,
            ..wire::SupervisorResourceSample::default()
        }),
        "future",
        2,
    );
    let mut channel = host_channel(vec![future], RecordingWriter::default(), limits());
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Err(ManagementChannelError::InvalidManagementPayload { .. })
    ));

    let future_header = crate::management_frame::encode_management_frame(
        wire::ManagementFrameHeader {
            protocol_version: protocol().to_wire(),
            connection_id: CONNECTION.into(),
            message_id: "future-header".into(),
            stream_seq: 2,
            sent_at_unix_ms: NOW + 10,
            ..wire::ManagementFrameHeader::default()
        },
        &super::super::support::payload(wire::management_payload::Body::SupervisorResourceSample(
            wire::SupervisorResourceSample {
                sampled_at_unix_ms: NOW + 1,
                ..wire::SupervisorResourceSample::default()
            },
        )),
    )
    .expect("future header frame");
    let mut channel = host_channel(vec![future_header], RecordingWriter::default(), limits());
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Err(ManagementChannelError::InvalidSentAt(value)) if value == NOW + 10
    ));

    let smuggled = frame(
        wire::management_payload::Body::SupervisorFault(wire::SupervisorFault {
            scope: wire::SupervisorFaultScope::ManagementChannel as i32,
            severity: wire::SupervisorFaultSeverity::Recoverable as i32,
            fault_code: "CHANNEL_FAULT".into(),
            redacted_detail: Some("domain content must not cross V1".into()),
            occurred_at_unix_ms: NOW + 1,
            ..wire::SupervisorFault::default()
        }),
        "smuggled",
        2,
    );
    let mut channel = host_channel(vec![smuggled], RecordingWriter::default(), limits());
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Err(ManagementChannelError::InvalidManagementPayload { .. })
    ));
}
