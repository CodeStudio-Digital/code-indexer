use std::io::{self, Cursor, Write};
use std::sync::atomic::{AtomicUsize, Ordering};

use agent_protocol::frame::{
    BootstrapChannelError, BootstrapError, CONTROL_FRAME_MAX_BYTES, EstablishedChannelError,
    FrameHeaderError, FrameValidationError, InboundFrameError, OutboundFrameError,
};
use agent_protocol::framing::DelimitedFrameCodec;

use crate::control::authority::EffectClock;
use crate::control::{
    ControlDriverError, ControlDriverEvent, ControlError, EffectivePreparedFacts, PrepareOutcome,
    RunnerBootstrapDriver, RunnerBootstrapError,
};
use crate::lifecycle::RunnerState;

use super::support::{
    FailWriter, ManualClock, SPEC_DEADLINE, SharedWriter, agent_hello_draft, attempt_frames,
    decode_written_frames, driver_with_clock, driver_with_frames, effective_facts,
    host_hello_frame_for_connection, host_hello_frame_with, launch_context, launch_nonce_authority,
};

#[test]
fn prepared_is_not_installed_when_response_write_fails() {
    let clock = ManualClock::new(1_000);
    let mut driver = driver_with_frames(attempt_frames(), FailWriter::default(), clock.clone());
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };

    clock.set(1_100);
    let result = driver.finish_prepare(hydration, effective_facts(1_050));

    assert!(matches!(
        result,
        Err(ControlDriverError::Channel(
            EstablishedChannelError::Framing(_)
        ))
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[derive(Debug, Default)]
struct DeadlineBoundaryClock {
    reads: AtomicUsize,
}

impl EffectClock for DeadlineBoundaryClock {
    fn now_unix_ms(&self) -> i64 {
        match self.reads.fetch_add(1, Ordering::SeqCst) {
            0 => 900,
            1 | 2 => 1_000,
            3 => SPEC_DEADLINE - 1,
            _ => SPEC_DEADLINE,
        }
    }
}

#[test]
fn prepare_reaching_deadline_before_send_writes_no_response() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let mut driver = driver_with_clock(attempt_frames(), writer, DeadlineBoundaryClock::default());
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    let bytes_before = output.bytes();

    let result = driver.finish_prepare(hydration, effective_facts(1_050));

    assert!(matches!(
        result,
        Err(ControlDriverError::Channel(
            EstablishedChannelError::Outbound(OutboundFrameError::Frame(
                FrameValidationError::InvalidHeader(FrameHeaderError::InvalidDeadline {
                    sent_at: SPEC_DEADLINE,
                    deadline_at: SPEC_DEADLINE,
                })
            ))
        ))
    ));
    assert_eq!(output.bytes(), bytes_before);
    assert_eq!(
        decode_written_frames(&output.bytes())
            .expect("only AgentHello")
            .len(),
        1
    );
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[test]
fn activate_expiring_after_physical_read_fails_closed() {
    let clock = ManualClock::new(1_000);
    let mut driver = driver_with_frames(attempt_frames(), SharedWriter::default(), clock.clone());
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    clock.set(1_100);
    driver
        .finish_prepare(hydration, effective_facts(1_050))
        .expect("AttemptPrepared commit");

    clock.set(SPEC_DEADLINE);
    let result = driver.receive_next();

    assert!(matches!(
        result,
        Err(ControlDriverError::Channel(
            EstablishedChannelError::Inbound(InboundFrameError::DeadlineExpired {
                deadline_at: SPEC_DEADLINE,
                observed_at: SPEC_DEADLINE,
            })
        ))
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[test]
fn hydration_token_from_another_driver_is_rejected() {
    let clock_b = ManualClock::new(1_000);
    let mut driver_a = driver_with_frames(
        attempt_frames(),
        SharedWriter::default(),
        ManualClock::new(1_000),
    );
    let mut driver_b =
        driver_with_frames(attempt_frames(), SharedWriter::default(), clock_b.clone());

    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(token_a)) =
        driver_a.receive_next().expect("Prepare A")
    else {
        panic!("expected hydration request A");
    };
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(_token_b)) =
        driver_b.receive_next().expect("Prepare B")
    else {
        panic!("expected hydration request B");
    };

    clock_b.set(1_100);
    let result = driver_b.finish_prepare(token_a, effective_facts(1_050));

    assert!(matches!(
        result,
        Err(ControlDriverError::Control(
            ControlError::InvalidHydrationToken
        ))
    ));
    assert!(driver_b.is_closed());
    assert_eq!(driver_b.state(), RunnerState::Exiting);
}

#[test]
fn abort_prepare_consumes_pending_and_closes_driver() {
    let clock = ManualClock::new(1_000);
    let mut driver = driver_with_frames(attempt_frames(), SharedWriter::default(), clock);
    assert!(matches!(
        driver.receive_next().expect("Prepare"),
        ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(_))
    ));

    driver.abort_prepare().expect("pending rejection");

    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
    assert!(matches!(
        driver.abort_prepare(),
        Err(ControlDriverError::NoPrepareInFlight)
    ));
}

#[test]
fn internal_clock_reaps_hydration_at_the_immutable_deadline() {
    let clock = ManualClock::new(1_000);
    let mut driver = driver_with_frames(attempt_frames(), SharedWriter::default(), clock.clone());
    assert!(matches!(
        driver.receive_next().expect("Prepare"),
        ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(_))
    ));

    clock.set(SPEC_DEADLINE - 1);
    assert!(!driver.reap_if_expired().expect("before deadline"));
    assert!(!driver.is_closed());

    clock.set(SPEC_DEADLINE);
    assert!(driver.reap_if_expired().expect("at deadline"));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[test]
fn invalid_internal_clock_reading_fails_closed() {
    let clock = ManualClock::new(1_000);
    let mut driver = driver_with_frames(attempt_frames(), SharedWriter::default(), clock.clone());
    clock.set(0);

    assert!(matches!(
        driver.reap_if_expired(),
        Err(ControlDriverError::InvalidClockReading(0))
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[test]
fn incomplete_or_contradictory_containment_facts_fail_closed() {
    let mut incomplete = effective_facts(1_050);
    incomplete.containment.unsupported_limits.pop();

    let mut contradictory = effective_facts(1_050);
    contradictory
        .containment
        .capabilities
        .as_mut()
        .expect("capabilities")
        .open_file_limit = true;

    assert_prepare_facts_rejected(incomplete);
    assert_prepare_facts_rejected(contradictory);
}

fn assert_prepare_facts_rejected(facts: EffectivePreparedFacts) {
    let clock = ManualClock::new(1_000);
    let mut driver = driver_with_frames(attempt_frames(), SharedWriter::default(), clock.clone());
    let ControlDriverEvent::Prepare(PrepareOutcome::HydrationRequired(hydration)) =
        driver.receive_next().expect("Prepare")
    else {
        panic!("expected hydration request");
    };
    clock.set(1_100);

    assert!(matches!(
        driver.finish_prepare(hydration, facts),
        Err(ControlDriverError::Control(
            ControlError::InvalidEffectiveContainment(_)
        ))
    ));
    assert!(driver.is_closed());
    assert_eq!(driver.state(), RunnerState::Exiting);
}

#[test]
fn host_hello_cannot_replace_the_launch_connection() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let encoded = host_hello_frame_for_connection("connection-other");
    let bootstrap = bootstrap_with_host_hello(&encoded, writer);

    assert!(matches!(
        bootstrap.establish_with_nonce(agent_hello_draft(), launch_nonce_authority()),
        Err(RunnerBootstrapError::Channel(
            BootstrapChannelError::Bootstrap(BootstrapError::ConnectionMismatch)
        ))
    ));
    let frames = decode_written_frames(&output.bytes()).expect("AgentHello output");
    assert_eq!(frames.len(), 1);
    assert_eq!(frames[0].header.as_ref().expect("header").stream_seq, 1);
}

#[test]
fn nonempty_agent_hello_draft_is_rejected_before_any_write() {
    let writer = SharedWriter::default();
    let output = writer.clone();
    let bootstrap = bootstrap_with_host_hello(&host_hello_frame_with(|_| {}), writer);
    let mut draft = agent_hello_draft();
    draft.launch_nonce = vec![3; 32];

    assert!(matches!(
        bootstrap.establish_with_nonce(draft, launch_nonce_authority()),
        Err(RunnerBootstrapError::Control(
            ControlError::InvalidAgentHello("AgentHello draft already contains a launch nonce")
        ))
    ));
    assert!(output.bytes().is_empty());
}

#[derive(Debug)]
struct AlwaysFailWriter;

impl Write for AlwaysFailWriter {
    fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("injected AgentHello write failure"))
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn agent_hello_write_failure_cannot_be_retried() {
    let bootstrap = bootstrap_with_host_hello(&host_hello_frame_with(|_| {}), AlwaysFailWriter);

    assert!(matches!(
        bootstrap.establish_with_nonce(agent_hello_draft(), launch_nonce_authority()),
        Err(RunnerBootstrapError::Channel(
            BootstrapChannelError::Framing(_)
        ))
    ));
}

#[test]
fn host_hello_cannot_choose_its_own_connection_token() {
    let encoded = host_hello_frame_with(|hello| {
        hello.connection_session_token = vec![4; 32];
    });
    let bootstrap = bootstrap_with_host_hello(&encoded, SharedWriter::default());

    assert!(matches!(
        bootstrap.establish_with_nonce(agent_hello_draft(), launch_nonce_authority()),
        Err(RunnerBootstrapError::Control(
            ControlError::InvalidHostHello("connection session token differs from launch context")
        ))
    ));
}

#[test]
fn host_hello_rejects_unimplemented_crc_and_budget_excess() {
    for encoded in [
        host_hello_frame_with(|hello| {
            hello
                .frame_limits
                .as_mut()
                .expect("frame limits")
                .transport_crc32c = true;
        }),
        host_hello_frame_with(|hello| {
            hello
                .frame_limits
                .as_mut()
                .expect("frame limits")
                .max_in_flight_bytes += 1;
        }),
    ] {
        let bootstrap = bootstrap_with_host_hello(&encoded, SharedWriter::default());
        assert!(matches!(
            bootstrap.establish_with_nonce(agent_hello_draft(), launch_nonce_authority()),
            Err(RunnerBootstrapError::Control(
                ControlError::InvalidHostHello(
                    "frame limits are invalid or exceed the hard control cap"
                )
            ))
        ));
    }
}

#[test]
fn launch_context_debug_redacts_bootstrap_secrets() {
    let debug = format!("{:?}", launch_context());

    assert_eq!(debug.matches("[REDACTED]").count(), 2);
    assert!(!debug.contains("launch_nonce_sha256"));
    assert!(!debug.contains("connection_session_token_sha256"));
}

fn bootstrap_with_host_hello<W: Write>(
    encoded: &[u8],
    writer: W,
) -> RunnerBootstrapDriver<Cursor<Vec<u8>>, W> {
    let maximum = u32::try_from(CONTROL_FRAME_MAX_BYTES).expect("control cap fits u32");
    let codec = DelimitedFrameCodec::new(maximum).expect("codec");
    let mut encoded_stream = Vec::new();
    codec
        .write_raw(&mut encoded_stream, encoded)
        .expect("delimited HostHello");
    RunnerBootstrapDriver::with_clock(
        Cursor::new(encoded_stream),
        writer,
        launch_context(),
        ManualClock::new(999),
    )
    .expect("bootstrap driver")
}
