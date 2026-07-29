use crate::generated::v1 as wire;
use crate::management_channel::{ManagementChannelError, ManagementReceiveOutcome};
use crate::version::ProtocolVersion;

use super::support::{
    CONNECTION, FailWriter, NOW, RecordingWriter, ack_for, appendable_host_channel, deadline,
    decode_delimited, decode_frame, delimited, event, frame, frame_with_context, frame_with_reply,
    host_channel, host_channel_with_hello, host_hello, launch_accepted, launch_attempt, limits,
    protocol, supervisor_channel, update_authority,
};

mod acknowledged;
mod capacity;
mod correlation;
mod lifecycle;
mod outbound;
mod semantic_gates;

fn pending(
    outcome: Option<ManagementReceiveOutcome>,
) -> Box<super::super::PendingManagementInbound> {
    match outcome.expect("frame") {
        ManagementReceiveOutcome::Pending(pending) => pending,
        ManagementReceiveOutcome::Replay(_) => panic!("expected pending frame"),
    }
}

#[test]
fn exact_replay_resends_identical_physical_response_without_new_sequence() {
    let inbound = frame_with_context(
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + 2,
            ..wire::SupervisorResourceSample::default()
        }),
        "event-1",
        2,
        protocol(),
        CONNECTION,
        Some(NOW + 4),
    );
    let writer = RecordingWriter::default();
    let mut channel = host_channel(vec![inbound.clone(), inbound], writer.clone(), limits());

    let first = pending(channel.begin_receive_with_clock(|| NOW + 2).expect("first"));
    let first_ack = ack_for(&first);
    let response = channel
        .commit_response_with_clock(*first, &first_ack, deadline(50), || NOW + 3)
        .expect("commit response");
    assert_eq!(response.into_receipt().stream_seq(), 2);
    let replay = channel
        .begin_receive_with_clock(|| NOW + 5)
        .expect("replay receive")
        .expect("replay frame");
    match replay {
        ManagementReceiveOutcome::Replay(replayed) => {
            assert_eq!(replayed.message_id(), "event-1");
            assert_eq!(replayed.stream_seq(), 2);
        }
        ManagementReceiveOutcome::Pending(_) => panic!("expected physical replay"),
    }

    let output = decode_delimited(&writer.bytes());
    assert_eq!(output.len(), 3);
    assert_eq!(output[1], output[2]);
    let (header, _) = decode_frame(&output[1]);
    assert_eq!(header.stream_seq, 2);
}

#[test]
fn semantic_retry_gets_new_header_sequence_and_reply_binding() {
    let event_body =
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + 1,
            ..wire::SupervisorResourceSample::default()
        });
    let first = frame(event_body.clone(), "event-1", 2);
    let second = frame(event_body, "event-2", 3);
    let writer = RecordingWriter::default();
    let mut channel = host_channel(vec![first, second], writer.clone(), limits());

    let first = pending(channel.begin_receive_with_clock(|| NOW + 2).expect("first"));
    let first_ack = ack_for(&first);
    channel
        .commit_response_with_clock(*first, &first_ack, deadline(50), || NOW + 3)
        .expect("first response");
    let second = pending(
        channel
            .begin_receive_with_clock(|| NOW + 4)
            .expect("second"),
    );
    let second_ack = ack_for(&second);
    channel
        .commit_response_with_clock(*second, &second_ack, deadline(50), || NOW + 5)
        .expect("second response");

    let output = decode_delimited(&writer.bytes());
    assert_eq!(output.len(), 3);
    let (first_header, first_payload) = decode_frame(&output[1]);
    let (second_header, second_payload) = decode_frame(&output[2]);
    assert_eq!(first_header.stream_seq, 2);
    assert_eq!(first_header.reply_to_message_id.as_deref(), Some("event-1"));
    assert_eq!(second_header.stream_seq, 3);
    assert_eq!(
        second_header.reply_to_message_id.as_deref(),
        Some("event-2")
    );
    let wire::management_payload::Body::ManagementAck(first_ack) =
        first_payload.body.expect("first ACK")
    else {
        panic!("expected first ACK");
    };
    let wire::management_payload::Body::ManagementAck(second_ack) =
        second_payload.body.expect("second ACK")
    else {
        panic!("expected second ACK");
    };
    assert_eq!(first_ack.acknowledged_message_id, "event-1");
    assert_eq!(second_ack.acknowledged_message_id, "event-2");
    assert_eq!(
        first_ack.acknowledged_payload_sha256,
        second_ack.acknowledged_payload_sha256
    );
    assert_ne!(output[1], output[2]);
}

#[test]
fn context_mismatch_sequence_gap_and_wrong_direction_fail_closed() {
    let cases = [
        frame_with_context(
            wire::management_payload::Body::LaunchAccepted(wire::LaunchAccepted::default()),
            "bad-protocol",
            2,
            ProtocolVersion::new(1, 2),
            CONNECTION,
            None,
        ),
        frame_with_context(
            wire::management_payload::Body::LaunchAccepted(wire::LaunchAccepted::default()),
            "bad-connection",
            2,
            super::support::protocol(),
            "management:foreign",
            None,
        ),
        event("gap", 3),
        frame(
            wire::management_payload::Body::LaunchAttemptProcess(
                wire::LaunchAttemptProcess::default(),
            ),
            "wrong-direction",
            2,
        ),
    ];
    for (index, bytes) in cases.into_iter().enumerate() {
        let mut channel = host_channel(vec![bytes], RecordingWriter::default(), limits());
        let error = channel
            .begin_receive_with_clock(|| NOW + 2)
            .expect_err("context rejection");
        assert!(channel.is_poisoned(), "case {index}");
        assert!(matches!(
            (index, error),
            (0, ManagementChannelError::ProtocolMismatch)
                | (1, ManagementChannelError::ConnectionMismatch)
                | (2, ManagementChannelError::SequenceMismatch { .. })
                | (3, ManagementChannelError::PayloadNotAllowed { .. })
        ));
    }
}

#[test]
fn same_message_id_with_different_bytes_is_a_conflict() {
    let first = event("duplicate", 2);
    let second = frame(
        wire::management_payload::Body::LaunchRejected(wire::LaunchRejected::default()),
        "duplicate",
        3,
    );
    let mut channel = host_channel(vec![first, second], RecordingWriter::default(), limits());
    let first = pending(channel.begin_receive_with_clock(|| NOW + 2).expect("first"));
    let response = ack_for(&first);
    channel
        .commit_response_with_clock(*first, &response, deadline(50), || NOW + 3)
        .expect("accept first");

    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 3),
        Err(ManagementChannelError::MessageIdConflict)
    ));
    assert!(channel.is_poisoned());
}

#[test]
fn foreign_pending_transaction_cannot_be_transplanted() {
    let mut first = host_channel(
        vec![event("first", 2)],
        RecordingWriter::default(),
        limits(),
    );
    let mut second = host_channel(
        vec![event("second", 2)],
        RecordingWriter::default(),
        limits(),
    );
    let _first_pending = pending(first.begin_receive_with_clock(|| NOW + 2).expect("first"));
    let second_pending = pending(second.begin_receive_with_clock(|| NOW + 2).expect("second"));

    assert!(matches!(
        first.reject(*second_pending),
        Err(ManagementChannelError::InvalidPendingInbound)
    ));
    assert!(first.is_poisoned());
}

#[test]
fn replay_bytes_and_tombstone_identity_are_independently_bounded() {
    let one_byte = super::super::ManagementReplayLimits::new(1, 3, 1).expect("small limits");
    let mut byte_limited = host_channel(
        vec![event("bytes", 2)],
        RecordingWriter::default(),
        one_byte,
    );
    let inbound = pending(
        byte_limited
            .begin_receive_with_clock(|| NOW + 2)
            .expect("inbound"),
    );
    let response = ack_for(&inbound);
    assert!(matches!(
        byte_limited.commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 3),
        Err(ManagementChannelError::ReplayByteBudgetExhausted { .. })
    ));

    let bounded = super::super::ManagementReplayLimits::new(1, 3, 64 * 1024).expect("limits");
    let first = event("one", 2);
    let second = event("two", 3);
    let mut channel = host_channel(
        vec![first.clone(), second, first],
        RecordingWriter::default(),
        bounded,
    );
    let one = pending(channel.begin_receive_with_clock(|| NOW + 2).expect("one"));
    let response = ack_for(&one);
    channel
        .commit_response_with_clock(*one, &response, deadline(50), || NOW + 2)
        .expect("commit one");
    let two = pending(channel.begin_receive_with_clock(|| NOW + 3).expect("two"));
    let response = ack_for(&two);
    channel
        .commit_response_with_clock(*two, &response, deadline(50), || NOW + 3)
        .expect("commit two");
    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 4),
        Err(ManagementChannelError::MessageIdRetired)
    ));
}
