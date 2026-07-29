use agent_protocol::frame::InboundBinding;
use agent_protocol::generated::v1 as wire;

use crate::lifecycle::RunnerState;

use super::RunnerControlSession;
use crate::control::error::ControlError;
use crate::control::model::{
    AcceptedTermination, CancelOutcome, CancelledAttempt, CommittedTermination, FenceOutcome,
    FencedAttempt, PendingTermination, TerminationCache,
};
use crate::control::validation::{validate_cancel, validate_fence};

impl RunnerControlSession {
    pub(in crate::control) fn plan_cancel(
        &self,
        request: wire::CancelAttempt,
        frame_payload_sha256: [u8; 32],
        binding: InboundBinding,
        observed_at_unix_ms: i64,
    ) -> Result<PendingTermination<CancelledAttempt>, ControlError> {
        let attempt = validate_cancel(
            &request,
            &self.launch,
            self.effective_deadline_at_unix_ms(),
            observed_at_unix_ms,
        )?;
        if let Some(accepted) = &self.termination {
            return match accepted {
                AcceptedTermination::Cancel(cache)
                    if cache.matches(&request.idempotency_key, &frame_payload_sha256) =>
                {
                    Ok(PendingTermination::retry(binding, attempt))
                }
                AcceptedTermination::Cancel(_) | AcceptedTermination::Fence(_) => {
                    Err(ControlError::TerminationConflict)
                }
            };
        }
        if self.lifecycle.state() != RunnerState::Active
            || self.authority.is_none()
            || self.effect_gate.is_none()
        {
            return Err(ControlError::TerminationNotActive);
        }

        let mut lifecycle = self.lifecycle.clone();
        lifecycle.transition(RunnerState::Cancelling)?;
        Ok(PendingTermination::fresh(
            binding,
            TerminationCache {
                idempotency_key: request.idempotency_key,
                frame_payload_sha256,
                attempt,
            },
            lifecycle,
        ))
    }

    pub(in crate::control) fn plan_fence(
        &self,
        request: wire::FenceAttempt,
        frame_payload_sha256: [u8; 32],
        binding: InboundBinding,
        observed_at_unix_ms: i64,
    ) -> Result<PendingTermination<FencedAttempt>, ControlError> {
        let attempt = validate_fence(&request, &self.launch, observed_at_unix_ms)?;
        if let Some(accepted) = &self.termination {
            return match accepted {
                AcceptedTermination::Fence(cache)
                    if cache.matches(&request.idempotency_key, &frame_payload_sha256) =>
                {
                    Ok(PendingTermination::retry(binding, attempt))
                }
                AcceptedTermination::Cancel(_) | AcceptedTermination::Fence(_) => {
                    Err(ControlError::TerminationConflict)
                }
            };
        }
        if self.lifecycle.state() != RunnerState::Active
            || self.authority.is_none()
            || self.effect_gate.is_none()
        {
            return Err(ControlError::TerminationNotActive);
        }

        let mut lifecycle = self.lifecycle.clone();
        lifecycle.transition(RunnerState::Cancelling)?;
        Ok(PendingTermination::fresh(
            binding,
            TerminationCache {
                idempotency_key: request.idempotency_key,
                frame_payload_sha256,
                attempt,
            },
            lifecycle,
        ))
    }

    pub(in crate::control) fn install_cancel(
        &mut self,
        committed: CommittedTermination<CancelledAttempt>,
    ) -> CancelOutcome {
        match committed {
            CommittedTermination::Fresh { cache, lifecycle } => {
                let attempt = cache.attempt.clone();
                self.termination = Some(AcceptedTermination::Cancel(cache));
                self.lifecycle = *lifecycle;
                CancelOutcome::Accepted(attempt)
            }
            CommittedTermination::Retry { attempt } => CancelOutcome::AlreadyAccepted(attempt),
        }
    }

    pub(in crate::control) fn install_fence(
        &mut self,
        committed: CommittedTermination<FencedAttempt>,
    ) -> FenceOutcome {
        match committed {
            CommittedTermination::Fresh { cache, lifecycle } => {
                let attempt = cache.attempt.clone();
                self.termination = Some(AcceptedTermination::Fence(cache));
                self.lifecycle = *lifecycle;
                FenceOutcome::Accepted(attempt)
            }
            CommittedTermination::Retry { attempt } => FenceOutcome::AlreadyAccepted(attempt),
        }
    }
}
