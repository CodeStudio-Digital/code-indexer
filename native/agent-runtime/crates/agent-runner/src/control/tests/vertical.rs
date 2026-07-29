use prost::Message;

use agent_protocol::frame::{EstablishedChannelError, frame_payload_sha256};
use agent_protocol::generated::v1 as wire;

use crate::control::{
    ActivationOutcome, AuthorityError, ControlDriverError, ControlDriverEvent, PrepareOutcome,
};
use crate::lifecycle::RunnerState;

use super::support::{
    ManualClock, SharedWriter, attempt_frames, decode_written_frames, driver_with_frames,
    effective_facts,
};

#[test]
fn same_stream_reaches_active_only_after_prepare_and_activate_commits() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let clock = ManualClock::new(1_000);
    let input = attempt_frames();
    let activate_frame = wire::Frame::decode(input[1].as_slice()).expect("Activate envelope");
    let activate_digest = frame_payload_sha256(&activate_frame.encoded_payload);
    let mut driver = driver_with_frames(input, writer, clock.clone());

    assert_eq!(driver.state(), RunnerState::Handshaking);
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    assert_eq!(driver.state(), RunnerState::Hydrating);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));

    clock.set(1_100);
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("AttemptPrepared commit");
    assert_eq!(driver.state(), RunnerState::Prepared);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));

    clock.set(1_200);
    let ControlDriverEvent::Activate(outcome) = driver.receive_next().expect("Activate commit")
    else {
        panic!("expected activation");
    };
    assert_eq!(outcome, ActivationOutcome::Activated);
    assert_eq!(driver.state(), RunnerState::Active);

    let token = driver.effect_token().expect("active effect token");
    let dispatched = driver
        .with_effect_dispatch(&token, |permit| format!("{permit:?}"))
        .expect("effect dispatch");
    assert!(dispatched.contains("EffectDispatchPermit"));

    let frames = decode_written_frames(&output.bytes()).expect("written frames");
    assert_eq!(frames.len(), 3);
    let mut frames = frames.into_iter();
    let hello = frames.next().expect("AgentHello frame");
    assert_eq!(
        hello.header.as_ref().expect("AgentHello header").stream_seq,
        1
    );
    let hello_payload =
        wire::FramePayload::decode(hello.encoded_payload.as_slice()).expect("AgentHello payload");
    assert!(matches!(
        hello_payload.body,
        Some(wire::frame_payload::Body::AgentHello(_))
    ));

    let prepared_frame = frames.next().expect("AttemptPrepared frame");
    let prepared_header = prepared_frame.header.as_ref().expect("Prepared header");
    assert_eq!(prepared_header.stream_seq, 2);
    assert_eq!(
        prepared_header.reply_to_message_id.as_deref(),
        Some("prepare-1")
    );
    let prepared_payload = wire::FramePayload::decode(prepared_frame.encoded_payload.as_slice())
        .expect("AttemptPrepared payload");
    let Some(wire::frame_payload::Body::AttemptPrepared(prepared)) = prepared_payload.body else {
        panic!("expected AttemptPrepared response");
    };
    assert_eq!(prepared.loaded_snapshots.len(), 7);
    assert_eq!(prepared.spec_sha256.len(), 32);

    let ack_frame = frames.next().expect("activation Ack frame");
    let ack_header = ack_frame.header.as_ref().expect("Ack header");
    assert_eq!(ack_header.stream_seq, 3);
    assert_eq!(
        ack_header.reply_to_message_id.as_deref(),
        Some("activate-1")
    );
    let ack_payload = wire::FramePayload::decode(ack_frame.encoded_payload.as_slice())
        .expect("activation Ack payload");
    let Some(wire::frame_payload::Body::Ack(ack)) = ack_payload.body else {
        panic!("expected activation Ack response");
    };
    assert_eq!(ack.acknowledged_message_id, "activate-1");
    assert_eq!(ack.acknowledged_payload_sha256, activate_digest);
    assert_eq!(ack.acknowledged_at_unix_ms, 1_200);

    assert!(matches!(
        driver.receive_next(),
        Err(ControlDriverError::Channel(
            EstablishedChannelError::UnexpectedEof
        ))
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));
}
