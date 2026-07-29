use crate::generated::v1 as wire;
use crate::management_channel::ManagementReceiveOutcome;

use super::super::support::{
    CONNECTION, NOW, RecordingWriter, deadline, decode_delimited, decode_frame, frame_with_context,
    host_channel, limits, protocol,
};

#[test]
fn commit_acknowledged_derives_correlation_and_replays_identical_bytes() {
    let inbound = frame_with_context(
        wire::management_payload::Body::SupervisorResourceSample(wire::SupervisorResourceSample {
            sampled_at_unix_ms: NOW + 2,
            ..wire::SupervisorResourceSample::default()
        }),
        "event-acknowledged",
        2,
        protocol(),
        CONNECTION,
        None,
    );
    let writer = RecordingWriter::default();
    let mut channel = host_channel(vec![inbound.clone(), inbound], writer.clone(), limits());

    let pending = super::pending(
        channel
            .begin_receive_with_clock(|| NOW + 2)
            .expect("receive pending inbound"),
    );
    let expected_message_id = pending.message_id().to_owned();
    let expected_payload_digest = *pending.payload_digest();
    let clock_before = channel.owner_now_unix_ms();
    let response = channel
        .commit_acknowledged(*pending, deadline(50))
        .expect("commit derived acknowledgement");
    let clock_after = channel.owner_now_unix_ms();

    assert_eq!(response.sent_frame().stream_seq(), 2);
    let receipt = response.into_receipt();
    assert_eq!(receipt.message_id(), expected_message_id);
    assert_eq!(receipt.stream_seq(), 2);

    let replay = channel
        .begin_receive_with_clock(|| NOW + 3)
        .expect("receive exact replay")
        .expect("replay outcome");
    let ManagementReceiveOutcome::Replay(replayed) = replay else {
        panic!("expected physical replay");
    };
    assert_eq!(replayed.message_id(), expected_message_id);
    assert_eq!(replayed.stream_seq(), 2);

    let output = decode_delimited(&writer.bytes());
    assert_eq!(output.len(), 3);
    assert_eq!(output[1], output[2]);

    let (header, payload) = decode_frame(&output[1]);
    assert_eq!(
        header.reply_to_message_id.as_deref(),
        Some(expected_message_id.as_str())
    );
    let Some(wire::management_payload::Body::ManagementAck(ack)) = payload.body else {
        panic!("expected ManagementAck");
    };
    assert_eq!(ack.acknowledged_message_id, expected_message_id);
    assert_eq!(
        ack.acknowledged_payload_sha256.as_slice(),
        expected_payload_digest
    );
    assert_eq!(header.sent_at_unix_ms, ack.acknowledged_at_unix_ms);
    assert!(
        (clock_before..=clock_after).contains(&ack.acknowledged_at_unix_ms),
        "ack timestamp must come from the channel-owned clock"
    );
}
