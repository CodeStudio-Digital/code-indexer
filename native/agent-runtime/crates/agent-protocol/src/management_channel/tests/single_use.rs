use crate::management_channel::{ManagementChannelError, ManagementReceiveOutcome};

use super::support::{NOW, RecordingWriter, ack_for, deadline, event, host_channel, limits};

#[test]
fn pending_payload_is_single_use_without_changing_its_commit_binding() {
    let mut channel = host_channel(
        vec![event("single-use", 2)],
        RecordingWriter::default(),
        limits(),
    );
    let Some(ManagementReceiveOutcome::Pending(mut inbound)) = channel
        .begin_receive_with_clock(|| NOW + 2)
        .expect("inbound")
    else {
        panic!("expected pending inbound");
    };

    let (_, digest) = inbound
        .take_validated_payload_and_digest()
        .expect("first take");
    assert_ne!(digest, [0; 32]);
    assert!(matches!(
        inbound.take_validated_payload_and_digest(),
        Err(ManagementChannelError::PendingPayloadConsumed)
    ));
    let response = ack_for(&inbound);
    channel
        .commit_response_with_clock(*inbound, &response, deadline(50), || NOW + 3)
        .expect("consumption does not change commit binding");
}

#[test]
fn established_eof_is_a_poisoning_disconnect_not_clean_idle() {
    let mut channel = host_channel(Vec::new(), RecordingWriter::default(), limits());

    assert!(matches!(
        channel.begin_receive_with_clock(|| NOW + 2),
        Err(ManagementChannelError::UnexpectedEof)
    ));
    assert!(channel.is_poisoned());
}
