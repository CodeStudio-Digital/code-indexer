use std::io::{Read, Write};

use agent_protocol::frame::{FrameReceiveOutcome, InboundBinding, PendingInbound};
use agent_protocol::generated::v1 as wire;

use super::{ControlDriverError, ControlDriverEvent, HeldPrepare, RunnerControlDriver};
use crate::control::ControlError;
use crate::control::model::{EffectivePreparedFacts, PrepareOutcome};

impl<R: Read, W: Write> RunnerControlDriver<R, W> {
    /// Receives and transactionally handles the next Prepare or Activate.
    ///
    /// Exact transport replays have already resent their bounded response when
    /// returned. A fresh Prepare remains reserved until `finish_prepare`.
    ///
    /// # Errors
    ///
    /// Fails closed on transport, framing, context, lifecycle, or validation
    /// errors. Calling while hydration is pending returns `PrepareInFlight`.
    pub(crate) fn receive_next_inner(&mut self) -> Result<ControlDriverEvent, ControlDriverError> {
        if self.pending_prepare.is_some() {
            return Err(ControlDriverError::PrepareInFlight);
        }
        let mut observed_at_unix_ms = None;
        let clock = std::sync::Arc::clone(&self.clock);
        let received = match self.channel.as_mut() {
            Some(channel) => channel.begin_receive(|| {
                let observed = clock.now_unix_ms();
                observed_at_unix_ms = Some(observed);
                observed
            }),
            None => return Err(ControlDriverError::Closed),
        };
        let received = match received {
            Ok(value) => value,
            Err(error) => return self.close_with(error.into()),
        };
        match received {
            FrameReceiveOutcome::Replay(replay) => Ok(ControlDriverEvent::Replayed(replay)),
            FrameReceiveOutcome::Pending(pending) => match observed_at_unix_ms {
                Some(observed) => self.handle_pending(*pending, observed),
                None => self.close_with(ControlDriverError::ReceiveTimestampMissing),
            },
        }
    }

    /// Commits the retained Prepare and only then installs Prepared state.
    ///
    /// # Errors
    ///
    /// Fails closed if hydration, frame construction, response bounding,
    /// receiver commit, or receipt binding validation fails.
    pub(crate) fn finish_prepare_inner(
        &mut self,
        token: crate::control::HydrationToken,
        facts: EffectivePreparedFacts,
    ) -> Result<(), ControlDriverError> {
        if self.pending_prepare.is_none() {
            return Err(ControlDriverError::NoPrepareInFlight);
        }
        let plan = match self
            .session
            .plan_finish_prepare(token, facts, self.clock.now_unix_ms())
        {
            Ok(plan) => plan,
            Err(error) => return self.close_with(error.into()),
        };
        let pending = self
            .pending_prepare
            .take()
            .ok_or(ControlDriverError::NoPrepareInFlight)?
            .inbound;
        let clock = std::sync::Arc::clone(&self.clock);
        let committed = match self
            .channel
            .as_mut()
            .ok_or(ControlDriverError::Closed)?
            .commit_response(pending, plan.response(), plan.deadline_at_unix_ms(), || {
                clock.now_unix_ms()
            }) {
            Ok(committed) => committed,
            Err(error) => return self.close_with(error.into()),
        };
        let Some(committed) = plan.bind(committed) else {
            return self.close_with(ControlDriverError::InboundBindingMismatch);
        };
        self.session.install_prepared(committed);
        Ok(())
    }

    fn handle_pending(
        &mut self,
        mut pending: PendingInbound,
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, ControlDriverError> {
        let decoded = self.session.take_inbound(&mut pending);
        let (binding, body, digest) = match decoded {
            Ok(decoded) => decoded,
            Err(error) => return self.reject_control(pending, error),
        };
        match body {
            wire::frame_payload::Body::PrepareAttempt(request) => {
                self.handle_prepare(pending, &binding, request, digest, observed_at_unix_ms)
            }
            wire::frame_payload::Body::ActivateAttempt(request) => {
                self.handle_activate(pending, binding, request, digest, observed_at_unix_ms)
            }
            _ => self.reject_control(
                pending,
                ControlError::UnexpectedInboundMessage("not PrepareAttempt or ActivateAttempt"),
            ),
        }
    }

    fn handle_prepare(
        &mut self,
        pending: PendingInbound,
        binding: &InboundBinding,
        request: wire::PrepareAttempt,
        digest: [u8; 32],
        observed_at_unix_ms: i64,
    ) -> Result<ControlDriverEvent, ControlDriverError> {
        let outcome =
            match self
                .session
                .begin_prepare(request, digest, binding.clone(), observed_at_unix_ms)
            {
                Ok(outcome) => outcome,
                Err(error) => return self.reject_control(pending, error),
            };
        match outcome {
            PrepareOutcome::HydrationRequired(token) => {
                self.pending_prepare = Some(HeldPrepare { inbound: pending });
                Ok(ControlDriverEvent::Prepare(
                    PrepareOutcome::HydrationRequired(token),
                ))
            }
            PrepareOutcome::AlreadyPrepared => {
                let Some(response) = self.session.prepared_response() else {
                    return self
                        .reject_driver(pending, ControlDriverError::PreparedResponseMissing);
                };
                let clock = std::sync::Arc::clone(&self.clock);
                let committed = match self
                    .channel
                    .as_mut()
                    .ok_or(ControlDriverError::Closed)?
                    .commit_response(
                        pending,
                        response,
                        self.session.effective_deadline_at_unix_ms(),
                        || clock.now_unix_ms(),
                    ) {
                    Ok(committed) => committed,
                    Err(error) => return self.close_with(error.into()),
                };
                let receipt = committed.into_receipt();
                if !receipt.matches(binding) {
                    return self.close_with(ControlDriverError::InboundBindingMismatch);
                }
                Ok(ControlDriverEvent::Prepare(PrepareOutcome::AlreadyPrepared))
            }
            PrepareOutcome::HydrationInProgress => {
                self.reject_driver(pending, ControlDriverError::PrepareInFlight)
            }
        }
    }

    pub(super) fn reject_control<T>(
        &mut self,
        pending: PendingInbound,
        error: ControlError,
    ) -> Result<T, ControlDriverError> {
        self.reject_driver(pending, error.into())
    }

    fn reject_driver<T>(
        &mut self,
        pending: PendingInbound,
        error: ControlDriverError,
    ) -> Result<T, ControlDriverError> {
        if let Some(channel) = self.channel.as_mut() {
            let _ignored = channel.reject(pending);
        }
        self.close_with(error)
    }
}
