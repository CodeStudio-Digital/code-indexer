use std::time::Duration;

use tokio::time::Instant;

use super::{
    RunnerPulseAuthenticationKey, RunnerPulseError, RunnerPulseIdentity, RunnerPulseSender,
    SupervisorPulseReceiver,
};
use crate::generated::v1 as wire;

const ATTEMPT_ID: &str = "00000000-0000-4000-8000-000000000004";
const RUNTIME_ID: &str = "runtime:pulse-test";
const CONNECTION_ID: &str = "connection:pulse-test";
const TOKEN: [u8; 32] = [0x5a; 32];

#[tokio::test]
async fn exact_authenticated_sequence_round_trips_without_extending_deadline() {
    let (runner, supervisor) = tokio::io::duplex(8 * 1024);
    let hard_deadline = Instant::now() + Duration::from_secs(2);
    let mut sender =
        RunnerPulseSender::new(runner, identity(), key(TOKEN), hard_deadline).expect("sender");
    let mut supervisor_rx =
        SupervisorPulseReceiver::new(supervisor, identity(), key(TOKEN), hard_deadline)
            .expect("receiver");

    let (sent, first_pulse) = tokio::join!(
        sender.send(
            wire::RunnerPulsePhase::Active,
            7,
            resources(64, 96),
            Duration::from_millis(100),
        ),
        supervisor_rx.receive(Duration::from_millis(100)),
    );
    assert_eq!(sent.expect("pulse sent"), 1);
    let first_pulse = first_pulse.expect("pulse received");
    assert_eq!(first_pulse.phase(), wire::RunnerPulsePhase::Active);
    assert_eq!(first_pulse.monotonic_counter(), 1);
    assert_eq!(first_pulse.last_progress_seq(), 7);
    assert_eq!(first_pulse.resources().resident_memory_bytes, 64);

    let (sent, second_pulse) = tokio::join!(
        sender.send(
            wire::RunnerPulsePhase::Waiting,
            7,
            resources(65, 96),
            Duration::from_millis(100),
        ),
        supervisor_rx.receive(Duration::from_millis(100)),
    );
    assert_eq!(sent.expect("second pulse sent"), 2);
    assert_eq!(
        second_pulse
            .expect("second pulse received")
            .monotonic_counter(),
        2
    );
}

#[tokio::test]
async fn wrong_key_fails_closed_and_consumes_receiver() {
    let (runner, supervisor) = tokio::io::duplex(8 * 1024);
    let hard_deadline = Instant::now() + Duration::from_secs(2);
    let mut sender =
        RunnerPulseSender::new(runner, identity(), key(TOKEN), hard_deadline).expect("sender");
    let mut supervisor_rx =
        SupervisorPulseReceiver::new(supervisor, identity(), key([0x33; 32]), hard_deadline)
            .expect("receiver");
    let (sent, pulse_result) = tokio::join!(
        sender.send(
            wire::RunnerPulsePhase::Active,
            0,
            resources(1, 1),
            Duration::from_millis(100),
        ),
        supervisor_rx.receive(Duration::from_millis(100)),
    );
    assert_eq!(sent.expect("wrong-key pulse sent"), 1);
    assert!(matches!(
        pulse_result,
        Err(RunnerPulseError::AuthenticationFailed)
    ));
    assert!(matches!(
        supervisor_rx.receive(Duration::from_millis(100)).await,
        Err(RunnerPulseError::Framing(_))
    ));
}

#[tokio::test]
async fn hard_deadline_bounds_each_wait_and_zero_timeout_is_rejected() {
    let (_runner, supervisor) = tokio::io::duplex(64);
    let mut supervisor_rx = SupervisorPulseReceiver::new(
        supervisor,
        identity(),
        key(TOKEN),
        Instant::now() + Duration::from_millis(10),
    )
    .expect("receiver");
    assert!(matches!(
        supervisor_rx.receive(Duration::ZERO).await,
        Err(RunnerPulseError::InvalidTimeout)
    ));
    assert!(matches!(
        supervisor_rx.receive(Duration::from_secs(5)).await,
        Err(RunnerPulseError::Framing(_))
    ));
}

#[test]
fn identity_key_phase_and_resource_inputs_are_bounded() {
    assert!(RunnerPulseIdentity::new("not-a-uuid", RUNTIME_ID, 9).is_err());
    assert!(RunnerPulseIdentity::new(ATTEMPT_ID, RUNTIME_ID, 0).is_err());
    assert!(RunnerPulseAuthenticationKey::new(CONNECTION_ID, vec![1; 15]).is_err());
    assert!(RunnerPulseAuthenticationKey::new(CONNECTION_ID, vec![1; 513]).is_err());
    assert!(RunnerPulseAuthenticationKey::new("", TOKEN.to_vec()).is_err());
}

fn identity() -> RunnerPulseIdentity {
    RunnerPulseIdentity::new(ATTEMPT_ID, RUNTIME_ID, 9).expect("identity")
}

fn key(token: [u8; 32]) -> RunnerPulseAuthenticationKey {
    RunnerPulseAuthenticationKey::new(CONNECTION_ID, token.to_vec()).expect("key")
}

fn resources(resident: u64, peak: u64) -> wire::ResourceSample {
    wire::ResourceSample {
        resident_memory_bytes: resident,
        peak_resident_memory_bytes: peak,
        cpu_time_ms: 10,
        process_count: 1,
        open_file_count: 2,
        spool_bytes: 0,
    }
}
