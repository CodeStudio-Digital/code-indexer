use std::io::{self, Write};
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_protocol::frame::EstablishedChannelError;

use crate::control::authority::EffectClock;
use crate::control::{AuthorityError, ControlDriverError, ControlDriverEvent, PrepareOutcome};
use crate::lifecycle::RunnerState;

use super::support::{
    FailWriter, ManualClock, SharedWriter, activate_frame_with_deadline, attempt_frames,
    decode_written_frames, decode_written_raw_frames, driver_with_clock, driver_with_frames,
    effective_facts, prepare_frame,
};

const NARROW_ACTIVATION_DEADLINE: i64 = 1_300;

#[test]
fn exact_activation_replay_resends_the_committed_ack_bytes() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let clock = ManualClock::new(1_000);
    let mut frames = attempt_frames();
    let activate = frames[1].clone();
    frames.push(activate);
    let mut driver = driver_with_frames(frames, writer, clock.clone());

    prepare(&mut driver, &clock);
    clock.set(1_200);
    assert!(matches!(
        driver.receive_next().expect("Activate"),
        ControlDriverEvent::Activate(_)
    ));
    let ControlDriverEvent::Replayed(replay) = driver.receive_next().expect("Activate replay")
    else {
        panic!("expected exact transport replay");
    };

    assert_eq!(replay.message_id(), "activate-1");
    assert_eq!(replay.stream_seq(), 3);
    assert_eq!(driver.state(), RunnerState::Active);
    let raw = decode_written_raw_frames(&output.bytes()).expect("raw outbound frames");
    assert_eq!(raw.len(), 4);
    assert_eq!(raw[2], raw[3]);
}

#[test]
fn failed_activation_ack_write_never_publishes_authority() {
    let clock = ManualClock::new(1_000);
    let writer = FailWriter::after_successful_writes(4);
    let mut driver = driver_with_frames(attempt_frames(), writer, clock.clone());

    prepare(&mut driver, &clock);
    clock.set(1_200);
    let result = driver.receive_next();

    assert!(matches!(
        result,
        Err(ControlDriverError::Channel(
            EstablishedChannelError::Framing(_)
        ))
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));
}

#[derive(Debug, Default)]
struct ActivationAckDeadlineClock {
    reads: AtomicUsize,
}

impl EffectClock for ActivationAckDeadlineClock {
    fn now_unix_ms(&self) -> i64 {
        match self.reads.fetch_add(1, Ordering::SeqCst) {
            0 => 900,
            1 | 2 => 1_000,
            3 | 4 => 1_100,
            5 => 1_200,
            _ => NARROW_ACTIVATION_DEADLINE,
        }
    }
}

#[test]
fn activation_reaching_deadline_before_ack_fails_closed() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let frames = vec![
        prepare_frame("prepare-1", 2),
        activate_frame_with_deadline("activate-1", 3, NARROW_ACTIVATION_DEADLINE),
    ];
    let mut driver = driver_with_clock(frames, writer, ActivationAckDeadlineClock::default());
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("AttemptPrepared");

    let result = driver.receive_next();

    assert!(matches!(
        result,
        Err(ControlDriverError::ActivationAckDeadlineElapsed {
            deadline: NARROW_ACTIVATION_DEADLINE,
            observed: NARROW_ACTIVATION_DEADLINE,
        })
    ));
    assert_eq!(
        decode_written_frames(&output.bytes())
            .expect("AgentHello and AttemptPrepared")
            .len(),
        2
    );
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));
}

#[derive(Debug)]
struct AdvanceClockWriter {
    inner: SharedWriter,
    clock: ManualClock,
    successful_writes: usize,
    advance_after_writes: usize,
    advanced_time: i64,
}

impl Write for AdvanceClockWriter {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buffer)?;
        self.successful_writes += 1;
        if self.successful_writes == self.advance_after_writes {
            self.clock.set(self.advanced_time);
        }
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[test]
fn activation_ack_completing_at_negotiated_write_deadline_never_publishes_authority() {
    const RESPONSE_STARTED_AT: i64 = 1_200;
    const WRITE_DEADLINE: i64 = 2_200;

    let output = SharedWriter::default();
    let clock = ManualClock::new(1_000);
    let writer = AdvanceClockWriter {
        inner: output.clone(),
        clock: clock.clone(),
        successful_writes: 0,
        // Delimited AgentHello, AttemptPrepared, then ActivateAck each use a
        // prefix write and a body write.
        advance_after_writes: 6,
        advanced_time: WRITE_DEADLINE,
    };
    let mut driver = driver_with_frames(attempt_frames(), writer, clock.clone());

    prepare(&mut driver, &clock);
    clock.set(RESPONSE_STARTED_AT);
    let result = driver.receive_next();

    assert!(matches!(
        result,
        Err(ControlDriverError::ActivationAckDeadlineElapsed {
            deadline: WRITE_DEADLINE,
            observed: WRITE_DEADLINE,
        })
    ));
    assert_eq!(
        decode_written_frames(&output.bytes())
            .expect("physically written frames")
            .len(),
        3
    );
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        driver.effect_token(),
        Err(AuthorityError::NotActive)
    ));
}

fn prepare(
    driver: &mut crate::control::RunnerControlDriver<std::io::Cursor<Vec<u8>>, impl std::io::Write>,
    clock: &ManualClock,
) {
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    clock.set(1_100);
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("AttemptPrepared");
}
