use prost::Message;
use zeroize::Zeroize;

use crate::frame::PULSE_FRAME_MAX_BYTES;
use crate::generated::v1 as wire;

use super::RunnerPulseError;
use super::authentication::RunnerPulseAuthenticationKey;
use super::model::{RunnerPulseIdentity, ValidatedRunnerPulse, validate_phase, validate_resources};

pub(super) fn encode_authenticated(
    key: &RunnerPulseAuthenticationKey,
    pulse: &wire::RunnerPulse,
) -> Result<Vec<u8>, RunnerPulseError> {
    let mut encoded_pulse = pulse.encode_to_vec();
    let mut tag = key.sign(&encoded_pulse);
    let frame = wire::PulseFrame {
        encoded_pulse: encoded_pulse.clone(),
        authentication_tag: tag.to_vec(),
    };
    let encoded = frame.encode_to_vec();
    encoded_pulse.zeroize();
    tag.zeroize();
    if encoded.is_empty() || encoded.len() > PULSE_FRAME_MAX_BYTES {
        return Err(RunnerPulseError::InvalidResources);
    }
    Ok(encoded)
}

pub(super) fn decode_authenticated(
    key: &RunnerPulseAuthenticationKey,
    identity: &RunnerPulseIdentity,
    expected_counter: Option<u64>,
    last_progress_seq: u64,
    encoded: &[u8],
) -> Result<ValidatedRunnerPulse, RunnerPulseError> {
    let mut frame = wire::PulseFrame::decode(encoded).map_err(RunnerPulseError::MalformedFrame)?;
    if frame.encode_to_vec() != encoded {
        scrub_frame(&mut frame);
        return Err(RunnerPulseError::NonCanonicalFrame);
    }
    if !key.verifies(&frame.encoded_pulse, &frame.authentication_tag) {
        scrub_frame(&mut frame);
        return Err(RunnerPulseError::AuthenticationFailed);
    }
    let pulse = wire::RunnerPulse::decode(frame.encoded_pulse.as_slice())
        .map_err(RunnerPulseError::MalformedFrame)?;
    if pulse.encode_to_vec() != frame.encoded_pulse {
        scrub_frame(&mut frame);
        return Err(RunnerPulseError::NonCanonicalFrame);
    }
    scrub_frame(&mut frame);
    validate_pulse(identity, expected_counter, last_progress_seq, &pulse)
}

fn validate_pulse(
    identity: &RunnerPulseIdentity,
    expected_counter: Option<u64>,
    last_progress_seq: u64,
    pulse: &wire::RunnerPulse,
) -> Result<ValidatedRunnerPulse, RunnerPulseError> {
    if !identity.matches(pulse) {
        return Err(RunnerPulseError::InvalidIdentity);
    }
    let phase = validate_phase(pulse.phase)?;
    let resources = pulse.resources.ok_or(RunnerPulseError::InvalidResources)?;
    validate_resources(&resources)?;
    let expected = expected_counter.ok_or(RunnerPulseError::CounterExhausted)?;
    if pulse.monotonic_counter != expected {
        return Err(RunnerPulseError::CounterMismatch {
            expected,
            actual: pulse.monotonic_counter,
        });
    }
    if pulse.last_progress_seq < last_progress_seq {
        return Err(RunnerPulseError::ProgressRegressed {
            previous: last_progress_seq,
            actual: pulse.last_progress_seq,
        });
    }
    Ok(ValidatedRunnerPulse::new(
        phase,
        pulse.monotonic_counter,
        pulse.last_progress_seq,
        resources,
    ))
}

fn scrub_frame(frame: &mut wire::PulseFrame) {
    frame.encoded_pulse.zeroize();
    frame.authentication_tag.zeroize();
}

#[cfg(test)]
#[path = "tests/codec.rs"]
mod tests;
