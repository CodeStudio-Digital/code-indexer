use std::fmt::{self, Debug, Formatter};

use agent_protocol::frame::{
    AsyncBoundDataAttemptChannel, AsyncEstablishedAttemptChannel, DataChannelLimits,
    FrameReceiveOutcome, PendingInbound,
};
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::super::{RunnerHydrationRequest, VerifiedRunnerHydration};

mod error;
mod message;
mod state;
pub(in crate::bootstrap::control_service) use error::HydrationDataPumpError;
use message::{ScrubbedHydrationBody, committed_payload, progress_payload};
use state::{HydrationPumpState, PumpTransition};

/// Trusted control-plane facts copied into every runner response.
pub(in crate::bootstrap::control_service) struct RunnerHydrationPumpContext {
    pub wire_identity: wire::AttemptIdentity,
    pub runtime_instance_id: String,
    pub hard_deadline: Instant,
    pub semantic_deadline_at_unix_ms: i64,
}

/// Verified payload ownership plus the still-authenticated data stream.
pub(in crate::bootstrap::control_service) struct CompletedHydrationPump<S> {
    pub hydration: VerifiedRunnerHydration,
    pub channel: AsyncEstablishedAttemptChannel<S>,
}

impl Debug for RunnerHydrationPumpContext {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerHydrationPumpContext")
            .field("identity", &self.wire_identity)
            .field("runtime_instance_id", &self.runtime_instance_id)
            .field("hard_deadline", &self.hard_deadline)
            .field(
                "semantic_deadline_at_unix_ms",
                &self.semantic_deadline_at_unix_ms,
            )
            .finish()
    }
}

impl<S> Debug for CompletedHydrationPump<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("CompletedHydrationPump")
            .field("hydration", &self.hydration)
            .field("channel", &self.channel)
            .finish()
    }
}

/// Receives one exact bounded hydration transaction over an authenticated data
/// channel.
///
/// Every accepted manifest/chunk is committed only with its response write.
/// Exact replays are answered by the protocol owner and never reach the
/// assembler twice.
///
/// # Errors
///
/// Fails closed on timeout, unexpected ordering, invalid content, replay
/// ambiguity, or any response write failure.
pub(in crate::bootstrap::control_service) async fn receive_hydration<S, F>(
    request: RunnerHydrationRequest,
    bound: AsyncBoundDataAttemptChannel<S>,
    context: RunnerHydrationPumpContext,
    mut clock: F,
) -> Result<CompletedHydrationPump<S>, HydrationDataPumpError>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
    F: FnMut() -> i64,
{
    if context.runtime_instance_id.trim().is_empty() || context.semantic_deadline_at_unix_ms <= 0 {
        return Err(HydrationDataPumpError::InvalidContext);
    }
    let limits = *bound.limits();
    let mut channel = bound.into_established();
    let mut state = HydrationPumpState::new(request);
    loop {
        let mut pending = receive_pending(&mut channel, &context, limits, &mut clock).await?;
        let (body, payload_digest) = pending.take_body_and_digest()?;
        let scrubbed = ScrubbedHydrationBody::new(body);
        let transition = match state.accept(
            scrubbed.as_ref(),
            payload_digest,
            limits.maximum_chunk_bytes(),
            &context,
        ) {
            Ok(value) => value,
            Err(error) => {
                drop(scrubbed);
                channel.reject(*pending)?;
                return Err(error);
            }
        };
        drop(scrubbed);
        let (response, hydration) = match transition {
            PumpTransition::Progress(response) => (response, None),
            PumpTransition::Committed {
                response,
                hydration,
            } => (response, Some(hydration)),
        };
        commit_response(
            &mut channel,
            *pending,
            &response,
            &context,
            limits.write_timeout(),
            &mut clock,
        )
        .await?;
        if let Some(hydration) = hydration {
            return Ok(CompletedHydrationPump { hydration, channel });
        }
    }
}

async fn receive_pending<S, F>(
    channel: &mut AsyncEstablishedAttemptChannel<S>,
    context: &RunnerHydrationPumpContext,
    limits: DataChannelLimits,
    clock: &mut F,
) -> Result<Box<PendingInbound>, HydrationDataPumpError>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
    F: FnMut() -> i64,
{
    loop {
        let outcome = channel
            .begin_receive(
                operation_deadline(context.hard_deadline, limits.read_timeout())?,
                context.hard_deadline,
                limits.write_timeout(),
                &mut *clock,
            )
            .await?;
        if let FrameReceiveOutcome::Pending(pending) = outcome {
            return Ok(pending);
        }
    }
}

async fn commit_response<S, F>(
    channel: &mut AsyncEstablishedAttemptChannel<S>,
    pending: agent_protocol::frame::PendingInbound,
    response: &wire::FramePayload,
    context: &RunnerHydrationPumpContext,
    write_timeout: std::time::Duration,
    clock: F,
) -> Result<(), HydrationDataPumpError>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
    F: FnOnce() -> i64,
{
    channel
        .commit_response(
            pending,
            response,
            context.semantic_deadline_at_unix_ms,
            operation_deadline(context.hard_deadline, write_timeout)?,
            clock,
        )
        .await?;
    Ok(())
}

fn operation_deadline(
    hard_deadline: Instant,
    timeout: std::time::Duration,
) -> Result<Instant, HydrationDataPumpError> {
    let now = Instant::now();
    if now >= hard_deadline {
        return Err(HydrationDataPumpError::DeadlineElapsed);
    }
    Ok(now
        .checked_add(timeout)
        .map_or(hard_deadline, |deadline| deadline.min(hard_deadline)))
}
