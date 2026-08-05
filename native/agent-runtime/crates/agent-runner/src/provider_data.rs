use std::collections::VecDeque;
use std::time::Duration;

use agent_protocol::frame::{
    AsyncEstablishedAttemptChannel, CommittedOutbound, FrameReceiveOutcome,
};
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

mod capabilities;
mod engine_events;
mod error;
mod event;
mod operations;
mod validation;

pub use error::ProviderDataError;
pub use event::ProviderWireEvent;
use validation::{validate_accepted, validate_start, validate_stream_event};

#[derive(Debug, Clone, Copy)]
pub struct ProviderDataTiming {
    pub hard_deadline: Instant,
    pub replay_write_timeout: Duration,
}

pub trait ProviderDataClock: Send + Sync {
    fn now_unix_ms(&self) -> i64;
}

impl<F> ProviderDataClock for F
where
    F: Fn() -> i64 + Send + Sync,
{
    fn now_unix_ms(&self) -> i64 {
        self()
    }
}

#[derive(Debug)]
struct ActiveProviderOperation {
    operation_id: String,
    next_event_sequence: u64,
}

#[derive(Debug)]
pub struct ProviderDataClient<S> {
    channel: AsyncEstablishedAttemptChannel<S>,
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    active: Option<ActiveProviderOperation>,
    buffered_events: VecDeque<ProviderWireEvent>,
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    #[must_use]
    pub const fn new(
        channel: AsyncEstablishedAttemptChannel<S>,
        identity: wire::AttemptIdentity,
        runtime_instance_id: String,
    ) -> Self {
        Self {
            channel,
            identity,
            runtime_instance_id,
            active: None,
            buffered_events: VecDeque::new(),
        }
    }

    /// Starts one provider operation and waits for its exact correlated
    /// `ProviderAccepted` response.
    ///
    /// # Errors
    ///
    /// Returns a typed error when authority, correlation, deadlines, framing,
    /// or physical I/O fail closed.
    pub async fn start<C: ProviderDataClock>(
        &mut self,
        start: wire::ProviderStart,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::ProviderAccepted, ProviderDataError> {
        self.start_observed(start, timing, clock, || {}).await
    }

    pub(crate) async fn start_observed<C, F>(
        &mut self,
        start: wire::ProviderStart,
        timing: ProviderDataTiming,
        clock: &C,
        on_committed: F,
    ) -> Result<wire::ProviderAccepted, ProviderDataError>
    where
        C: ProviderDataClock,
        F: FnOnce() + Send,
    {
        if self.active.is_some() {
            return Err(ProviderDataError::OperationAlreadyActive);
        }
        validate_start(&start, &self.identity)?;
        let operation_id = start.operation_id.clone();
        let semantic_deadline = start.deadline_at_unix_ms;
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::ProviderStart(start)),
        };
        let request = self
            .channel
            .send_new(&payload, semantic_deadline, timing.hard_deadline, || {
                clock.now_unix_ms()
            })
            .await?;
        on_committed();
        let accepted = self
            .receive_accepted(&request, &operation_id, timing, clock)
            .await?;
        self.active = Some(ActiveProviderOperation {
            operation_id,
            next_event_sequence: 1,
        });
        Ok(accepted)
    }

    /// Receives and commits the next authenticated provider stream event.
    ///
    /// # Errors
    ///
    /// Returns a typed error for an inactive operation, invalid stream event,
    /// failed correlation, deadline, framing, or physical I/O.
    pub async fn next<C: ProviderDataClock>(
        &mut self,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<ProviderWireEvent, ProviderDataError> {
        if let Some(event) = self.buffered_events.pop_front() {
            return Ok(event);
        }
        loop {
            let active = self
                .active
                .as_ref()
                .ok_or(ProviderDataError::NoActiveOperation)?;
            let outcome = self
                .channel
                .begin_receive(
                    timing.hard_deadline,
                    timing.hard_deadline,
                    timing.replay_write_timeout,
                    || clock.now_unix_ms(),
                )
                .await?;
            let FrameReceiveOutcome::Pending(mut pending) = outcome else {
                continue;
            };
            let binding = pending.binding();
            let header = pending.header().clone();
            let (body, _) = pending.take_body_and_digest()?;
            let event = validate_stream_event(
                body,
                &header,
                &active.operation_id,
                active.next_event_sequence,
            )?;
            let receipt = self.channel.commit_accepted(*pending)?;
            if !receipt.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            let terminal = event.is_terminal();
            if terminal {
                self.active = None;
            } else if let Some(active) = self.active.as_mut() {
                active.next_event_sequence = active
                    .next_event_sequence
                    .checked_add(1)
                    .ok_or(ProviderDataError::EventSequenceExhausted)?;
            }
            return Ok(event);
        }
    }

    async fn receive_accepted<C: ProviderDataClock>(
        &mut self,
        request: &CommittedOutbound,
        operation_id: &str,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::ProviderAccepted, ProviderDataError> {
        loop {
            let outcome = self
                .channel
                .begin_receive(
                    timing.hard_deadline,
                    timing.hard_deadline,
                    timing.replay_write_timeout,
                    || clock.now_unix_ms(),
                )
                .await?;
            let FrameReceiveOutcome::Pending(mut pending) = outcome else {
                continue;
            };
            let binding = pending.binding();
            let header = pending.header().clone();
            let (body, _) = pending.take_body_and_digest()?;
            let accepted = validate_accepted(
                body,
                &header,
                request,
                operation_id,
                &self.runtime_instance_id,
                clock.now_unix_ms(),
            )?;
            let receipt = self.channel.commit_accepted(*pending)?;
            if !receipt.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            return Ok(accepted);
        }
    }
}

#[cfg(test)]
mod tests;
