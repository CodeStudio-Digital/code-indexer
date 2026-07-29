use crate::control::{ControlDriverEvent, PrepareOutcome};
use crate::lifecycle::RunnerState;

use super::support::{
    ManualClock, SharedWriter, decode_written_frames, decode_written_raw_frames,
    driver_with_frames, effective_facts, prepare_frame,
};

#[test]
fn semantic_prepare_retry_gets_a_fresh_header_and_the_same_payload() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let clock = ManualClock::new(1_000);
    let frames = vec![prepare_frame("prepare-1", 2), prepare_frame("prepare-2", 3)];
    let mut driver = driver_with_frames(frames, writer, clock.clone());

    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("first Prepare")
    else {
        panic!("expected hydration request");
    };
    clock.set(1_100);
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("first AttemptPrepared commit");

    clock.set(1_200);
    assert!(matches!(
        driver.receive_next().expect("semantic Prepare retry"),
        ControlDriverEvent::Prepare(PrepareOutcome::AlreadyPrepared)
    ));
    assert_eq!(driver.state(), RunnerState::Prepared);

    let raw = decode_written_raw_frames(&output.bytes()).expect("raw outbound frames");
    let decoded = decode_written_frames(&output.bytes()).expect("decoded outbound frames");
    assert_eq!(raw.len(), 3);
    assert_eq!(decoded.len(), 3);

    let first = &decoded[1];
    let retry = &decoded[2];
    let first_header = first.header.as_ref().expect("first Prepared header");
    let retry_header = retry.header.as_ref().expect("retry Prepared header");
    assert_eq!(first_header.stream_seq, 2);
    assert_eq!(
        first_header.reply_to_message_id.as_deref(),
        Some("prepare-1")
    );
    assert_eq!(retry_header.stream_seq, 3);
    assert_eq!(
        retry_header.reply_to_message_id.as_deref(),
        Some("prepare-2")
    );
    assert_eq!(first.encoded_payload, retry.encoded_payload);
    assert_ne!(raw[1], raw[2]);
}

#[test]
fn exact_physical_prepare_replay_resends_identical_response_bytes() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let clock = ManualClock::new(1_000);
    let prepare = prepare_frame("prepare-1", 2);
    let mut driver = driver_with_frames(vec![prepare.clone(), prepare], writer, clock.clone());

    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("first Prepare")
    else {
        panic!("expected hydration request");
    };
    clock.set(1_100);
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("AttemptPrepared commit");

    clock.set(1_200);
    let ControlDriverEvent::Replayed(replay) =
        driver.receive_next().expect("exact physical replay")
    else {
        panic!("expected replay");
    };
    assert_eq!(replay.message_id(), "prepare-1");
    assert_eq!(replay.stream_seq(), 2);
    assert_eq!(driver.state(), RunnerState::Prepared);

    let raw = decode_written_raw_frames(&output.bytes()).expect("raw outbound frames");
    let decoded = decode_written_frames(&output.bytes()).expect("decoded outbound frames");
    assert_eq!(raw.len(), 3);
    assert_eq!(decoded.len(), 3);
    assert_eq!(raw[1], raw[2]);
    assert_eq!(
        decoded[1]
            .header
            .as_ref()
            .expect("first Prepared header")
            .stream_seq,
        2
    );
    assert_eq!(
        decoded[2]
            .header
            .as_ref()
            .expect("replayed Prepared header")
            .stream_seq,
        2
    );
}
