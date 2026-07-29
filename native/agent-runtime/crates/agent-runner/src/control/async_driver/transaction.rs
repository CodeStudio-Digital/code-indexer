use std::sync::Arc;
use std::time::Duration;

use agent_protocol::frame::{
    AsyncEstablishedAttemptChannel, FrameReceiveOutcome, InboundBinding, PendingInbound,
};
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{AsyncControlDriverError, AsyncHeldPrepare, AsyncRunnerControlDriver};
use crate::control::driver::ControlDriverEvent;
use crate::control::model::{EffectivePreparedFacts, PrepareOutcome};
use crate::control::{ControlError, HydrationToken};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    pub(super) async fn receive_next_inner(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
    ) -> Result<ControlDriverEvent, AsyncControlDriverError> {
        if self.pending_prepare.is_some() {
            return Err(AsyncControlDriverError::PrepareInFlight);
        }
        let read_deadline = match self.read_deadline() {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        let replay_hard_deadline = match self.hard_deadline() {
            Ok(value) => value,
            Err(error) => return self.close_with(error),
        };
        let replay_write_timeout = match self.session.write_timeout_ms() {
            Ok(value) => Duration::from_millis(value),
            Err(error) => return self.close_with(error.into()),
        };
        let mut observed_at_unix_ms = None;
        let clock = Arc::clone(&self.clock);
        let received = channel
            .begin_receive(
                read_deadline,
                replay_hard_deadline,
                replay_write_timeout,
                || {
                    let observed = clock.now_unix_ms();
                    observed_at_unix_ms = Some(observed);
                    observed
                },
            )
            .await;
        let received = match received {
            Ok(value) => value,
            Err(error) => return self.close_with(error.into()),
        };
        match received {
            FrameReceiveOutcome::Replay(replay) => Ok(ControlDriverEvent::Replayed(replay)),
            FrameReceiveOutcome::Pending(pending) => match observed_at_unix_ms {
                Some(observed) => self.handle_pending(channel, *pending, observed).await,
                None => self.close_with(AsyncControlDriverError::ReceiveTimestampMissing),
            },
        }
    }

    pub(super) async fn finish_prepare_inner(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        token: HydrationToken,
        facts: EffectivePreparedFacts,
    ) -> Result<(), AsyncControlDriverError> {
        if self.pending_prepare.is_none() {
            return Err(AsyncControlDriverError::NoPrepareInFlight);
        }
        let plan = match self
            .session
            .plan_finish_prepare(token, facts, self.clock.now_unix_ms())
        {
            Ok(plan) => plan,
            Err(error) => return self.close_with(error.into()),
        };
        let semantic_deadline = plan.deadline_at_unix_ms();
        let physical_deadline =
            match self.write_deadline(semantic_deadline, "AttemptPrepared write") {
                Ok(value) => value,
                Err(error) => return self.close_with(error),
            };
        let pending = self
            .pending_prepare
            .take()
            .ok_or(AsyncControlDriverError::NoPrepareInFlight)?
            .inbound;
        let clock = Arc::clone(&self.clock);
        let committed = match channel
            .commit_response(
                pending,
                plan.response(),
                semantic_deadline,
                physical_deadline,
                || clock.now_unix_ms(),
            )
            .await
        {
            Ok(committed) => committed,
            Err(error) => return self.close_with(error.into()),
        };
        let Some(committed) = plan.bind(committed) else {
            return self.close_with(AsyncControlDriverError::InboundBindingMismatch);
        };
        self.session.install_prepared(committed);
        Ok(())
    }

    pub(super) async fn handle_prepare(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        binding: &InboundBinding,
        request: wire::PrepareAttempt,
        digest: [u8; 32],
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, AsyncControlDriverError> {
        let outcome =
            match self
                .session
                .begin_prepare(request, digest, binding.clone(), observed_at_unix_ms)
            {
                Ok(outcome) => outcome,
                Err(error) => return self.reject_control(channel, pending, error),
            };
        match outcome {
            PrepareOutcome::HydrationRequired(token) => {
                self.pending_prepare = Some(AsyncHeldPrepare { inbound: pending });
                Ok(ControlDriverEvent::Prepare(
                    PrepareOutcome::HydrationRequired(token),
                ))
            }
            PrepareOutcome::AlreadyPrepared => {
                let Some(response) = self.session.prepared_response() else {
                    return self.reject_driver(
                        channel,
                        pending,
                        AsyncControlDriverError::PreparedResponseMissing,
                    );
                };
                let semantic_deadline = self.session.effective_deadline_at_unix_ms();
                let physical_deadline =
                    match self.write_deadline(semantic_deadline, "AttemptPrepared replay write") {
                        Ok(value) => value,
                        Err(error) => return self.close_with(error),
                    };
                let clock = Arc::clone(&self.clock);
                let committed = match channel
                    .commit_response(
                        pending,
                        response,
                        semantic_deadline,
                        physical_deadline,
                        || clock.now_unix_ms(),
                    )
                    .await
                {
                    Ok(committed) => committed,
                    Err(error) => return self.close_with(error.into()),
                };
                if !committed.into_receipt().matches(binding) {
                    return self.close_with(AsyncControlDriverError::InboundBindingMismatch);
                }
                Ok(ControlDriverEvent::Prepare(PrepareOutcome::AlreadyPrepared))
            }
            PrepareOutcome::HydrationInProgress => {
                self.reject_driver(channel, pending, AsyncControlDriverError::PrepareInFlight)
            }
        }
    }

    pub(super) fn reject_control<T>(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        error: ControlError,
    ) -> Result<T, AsyncControlDriverError> {
        self.reject_driver(channel, pending, error.into())
    }

    fn reject_driver<T>(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        pending: PendingInbound,
        error: AsyncControlDriverError,
    ) -> Result<T, AsyncControlDriverError> {
        let _ignored = channel.reject(pending);
        self.close_with(error)
    }
}
