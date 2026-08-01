use std::cmp::min;
use std::fmt::{self, Debug, Formatter};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadHalf, WriteHalf};
use tokio::time::Instant;
use zeroize::Zeroize;

use crate::frame::PULSE_FRAME_MAX_BYTES;
use crate::framing::DelimitedFrameCodec;
use crate::framing::asynchronous::{
    AsyncDelimitedFrameChannel, AsyncFrameReader, AsyncFrameWriter,
};
use crate::generated::v1 as wire;

use super::RunnerPulseError;
use super::authentication::RunnerPulseAuthenticationKey;
use super::codec::{decode_authenticated, encode_authenticated};
use super::model::{RunnerPulseIdentity, ValidatedRunnerPulse, validate_phase, validate_resources};

/// Single-owner authenticated pulse sender used only by the runner.
pub struct RunnerPulseSender<S> {
    identity: RunnerPulseIdentity,
    key: RunnerPulseAuthenticationKey,
    writer: Option<AsyncFrameWriter<WriteHalf<S>>>,
    _read_owner: AsyncFrameReader<ReadHalf<S>>,
    hard_deadline: Instant,
    next_counter: Option<u64>,
}

/// Single-owner authenticated pulse receiver used only by the supervisor.
pub struct SupervisorPulseReceiver<S> {
    identity: RunnerPulseIdentity,
    key: RunnerPulseAuthenticationKey,
    reader: Option<AsyncFrameReader<ReadHalf<S>>>,
    _write_owner: AsyncFrameWriter<WriteHalf<S>>,
    hard_deadline: Instant,
    expected_counter: Option<u64>,
    last_progress_seq: u64,
}

type PulseFrameHalves<S> = (
    AsyncFrameReader<ReadHalf<S>>,
    AsyncFrameWriter<WriteHalf<S>>,
);

impl<S> Debug for RunnerPulseSender<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerPulseSender")
            .field("identity", &"[REDACTED]")
            .field("stream_open", &self.writer.is_some())
            .field("hard_deadline", &self.hard_deadline)
            .field("next_counter", &self.next_counter)
            .finish_non_exhaustive()
    }
}

impl<S> Debug for SupervisorPulseReceiver<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorPulseReceiver")
            .field("identity", &"[REDACTED]")
            .field("stream_open", &self.reader.is_some())
            .field("hard_deadline", &self.hard_deadline)
            .field("expected_counter", &self.expected_counter)
            .field("last_progress_seq", &self.last_progress_seq)
            .finish_non_exhaustive()
    }
}

impl<S> RunnerPulseSender<S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    /// Takes the exact pulse stream and immutable attempt hard deadline.
    ///
    /// # Errors
    ///
    /// Returns a framing error if the bounded channel cannot be materialized.
    pub fn new(
        stream: S,
        identity: RunnerPulseIdentity,
        key: RunnerPulseAuthenticationKey,
        hard_deadline: Instant,
    ) -> Result<Self, RunnerPulseError> {
        let (reader, writer) = split(stream)?;
        Ok(Self {
            identity,
            key,
            writer: Some(writer),
            _read_owner: reader,
            hard_deadline,
            next_counter: Some(1),
        })
    }

    /// Commits one pulse. The counter advances only after the physical write.
    ///
    /// # Errors
    ///
    /// Rejects invalid semantic input, timeout/deadline expiry, counter
    /// exhaustion, or any physical write failure. A physical failure consumes
    /// the sender stream.
    pub async fn send(
        &mut self,
        phase: wire::RunnerPulsePhase,
        last_progress_seq: u64,
        resources: wire::ResourceSample,
        write_timeout: Duration,
    ) -> Result<u64, RunnerPulseError> {
        validate_phase(phase as i32)?;
        validate_resources(&resources)?;
        let counter = self
            .next_counter
            .ok_or(RunnerPulseError::CounterExhausted)?;
        let pulse = self
            .identity
            .pulse(phase, counter, last_progress_seq, resources);
        let encoded = encode_authenticated(&self.key, &pulse)?;
        let deadline = operation_deadline(self.hard_deadline, write_timeout)?;
        let mut writer = self.writer.take().ok_or_else(poisoned)?;
        let result = writer.send(&encoded, deadline).await;
        let mut encoded = encoded;
        encoded.zeroize();
        drop(encoded);
        result?;
        self.writer = Some(writer);
        self.next_counter = counter.checked_add(1);
        Ok(counter)
    }
}

impl<S> SupervisorPulseReceiver<S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    /// Takes the exact pulse stream and immutable attempt hard deadline.
    ///
    /// # Errors
    ///
    /// Returns a framing error if the bounded channel cannot be materialized.
    pub fn new(
        stream: S,
        identity: RunnerPulseIdentity,
        key: RunnerPulseAuthenticationKey,
        hard_deadline: Instant,
    ) -> Result<Self, RunnerPulseError> {
        let (reader, writer) = split(stream)?;
        Ok(Self {
            identity,
            key,
            reader: Some(reader),
            _write_owner: writer,
            hard_deadline,
            expected_counter: Some(1),
            last_progress_seq: 0,
        })
    }

    /// Receives exactly one authenticated pulse under timeout and hard deadline.
    ///
    /// # Errors
    ///
    /// Rejects timeout/deadline expiry, framing/authentication failure, identity
    /// mismatch, invalid resources, replay/gap, or progress regression. Any
    /// received invalid frame consumes the receiver stream.
    pub async fn receive(
        &mut self,
        pulse_timeout: Duration,
    ) -> Result<ValidatedRunnerPulse, RunnerPulseError> {
        let deadline = operation_deadline(self.hard_deadline, pulse_timeout)?;
        let mut reader = self.reader.take().ok_or_else(poisoned)?;
        let mut encoded = reader.receive(deadline).await?;
        let decoded = decode_authenticated(
            &self.key,
            &self.identity,
            self.expected_counter,
            self.last_progress_seq,
            &encoded,
        );
        encoded.zeroize();
        drop(encoded);
        let pulse = decoded?;
        self.reader = Some(reader);
        self.expected_counter = pulse.monotonic_counter().checked_add(1);
        self.last_progress_seq = pulse.last_progress_seq();
        Ok(pulse)
    }
}

fn split<S>(stream: S) -> Result<PulseFrameHalves<S>, RunnerPulseError>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    let maximum =
        u32::try_from(PULSE_FRAME_MAX_BYTES).map_err(|_| RunnerPulseError::InvalidResources)?;
    let codec = DelimitedFrameCodec::new(maximum).expect("pulse frame cap is non-zero");
    AsyncDelimitedFrameChannel::new(codec, stream)
        .into_split()
        .map_err(Into::into)
}

fn operation_deadline(
    hard_deadline: Instant,
    timeout: Duration,
) -> Result<Instant, RunnerPulseError> {
    if timeout.is_zero() {
        return Err(RunnerPulseError::InvalidTimeout);
    }
    let timeout_deadline = Instant::now().checked_add(timeout).unwrap_or(hard_deadline);
    Ok(min(hard_deadline, timeout_deadline))
}

const fn poisoned() -> RunnerPulseError {
    RunnerPulseError::Framing(crate::framing::AsyncFramingError::ChannelPoisoned)
}
