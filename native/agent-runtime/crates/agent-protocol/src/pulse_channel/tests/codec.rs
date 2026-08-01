use prost::Message;

use super::{decode_authenticated, encode_authenticated};
use crate::generated::v1 as wire;
use crate::pulse_channel::{RunnerPulseAuthenticationKey, RunnerPulseError, RunnerPulseIdentity};

const ATTEMPT_ID: &str = "00000000-0000-4000-8000-000000000004";

#[test]
fn counter_gap_and_progress_regression_fail_closed_after_authentication() {
    let key = key();
    let identity = identity();
    let counter_gap = encode_authenticated(&key, &pulse(&identity, 2, 9)).expect("encoded pulse");
    assert!(matches!(
        decode_authenticated(&key, &identity, Some(1), 0, &counter_gap),
        Err(RunnerPulseError::CounterMismatch {
            expected: 1,
            actual: 2
        })
    ));

    let progress_regression =
        encode_authenticated(&key, &pulse(&identity, 1, 8)).expect("encoded pulse");
    assert!(matches!(
        decode_authenticated(&key, &identity, Some(1), 9, &progress_regression),
        Err(RunnerPulseError::ProgressRegressed {
            previous: 9,
            actual: 8
        })
    ));
}

#[test]
fn authenticated_unknown_inner_field_is_still_rejected_as_noncanonical() {
    let key = key();
    let identity = identity();
    let mut encoded_pulse = pulse(&identity, 1, 0).encode_to_vec();
    encoded_pulse.extend_from_slice(&[0x78, 0x01]);
    let frame = wire::PulseFrame {
        authentication_tag: key.sign(&encoded_pulse).to_vec(),
        encoded_pulse,
    }
    .encode_to_vec();

    assert!(matches!(
        decode_authenticated(&key, &identity, Some(1), 0, &frame),
        Err(RunnerPulseError::NonCanonicalFrame)
    ));
}

fn pulse(identity: &RunnerPulseIdentity, counter: u64, progress: u64) -> wire::RunnerPulse {
    identity.pulse(
        wire::RunnerPulsePhase::Active,
        counter,
        progress,
        wire::ResourceSample {
            resident_memory_bytes: 64,
            peak_resident_memory_bytes: 96,
            cpu_time_ms: 10,
            process_count: 1,
            open_file_count: 2,
            spool_bytes: 0,
        },
    )
}

fn identity() -> RunnerPulseIdentity {
    RunnerPulseIdentity::new(ATTEMPT_ID, "runtime:pulse-codec", 9).expect("identity")
}

fn key() -> RunnerPulseAuthenticationKey {
    RunnerPulseAuthenticationKey::new("connection:pulse-codec", vec![0x44; 32]).expect("key")
}
