use std::sync::Arc;

use agent_protocol::frame::InboundBinding;
use agent_protocol::generated::v1 as wire;
use agent_protocol::handshake::HandshakeEvent;

use crate::lifecycle::RunnerState;

use super::RunnerControlSession;
use crate::control::authority::{ActiveAuthority, EffectClock};
#[cfg(test)]
use crate::control::authority::{AuthorityError, EffectDispatchPermit, EffectToken};
use crate::control::error::ControlError;
use crate::control::model::{
    ActivationCache, ActivationOutcome, CommittedActivation, PendingActivation,
    PendingFreshActivation, PreparationState,
};
use crate::control::validation::validate_activate;

impl RunnerControlSession {
    /// Converts durable host authority into the only capability that admits effects.
    ///
    /// # Errors
    ///
    /// Returns an error when the frame does not match the prepared attempt or
    /// its immutable activation authority.
    pub(in crate::control) fn plan_activate(
        &self,
        request: wire::ActivateAttempt,
        frame_payload_sha256: [u8; 32],
        inbound_binding: InboundBinding,
        now_unix_ms: i64,
    ) -> Result<PendingActivation, ControlError> {
        let Some(PreparationState::Prepared(prepared)) = self.preparation.as_ref() else {
            return Err(ControlError::ActivationBeforePrepare);
        };
        if let Some(cached) = &self.activation {
            return if cached.idempotency_key == request.idempotency_key
                && cached.frame_payload_sha256 == frame_payload_sha256
            {
                Ok(PendingActivation::Retry {
                    binding: inbound_binding,
                })
            } else {
                Err(ControlError::ActivationConflict)
            };
        }

        validate_activate(&request, prepared, &self.launch, now_unix_ms)?;
        let connection = self
            .connection
            .as_ref()
            .ok_or(ControlError::ConnectionNotEstablished)?;
        let authority = ActiveAuthority::new(
            self.launch.identity().clone(),
            self.launch.runtime_instance_id().clone(),
            connection.connection_id.clone(),
            request.agent_run_version,
            request.attempt_version,
            request.deadline_at_unix_ms,
            prepared.spec_sha256,
            &request.activation_nonce,
        );
        let mut handshake = self.handshake.clone();
        let mut lifecycle = self.lifecycle.clone();
        handshake.apply(HandshakeEvent::ActivateAccepted(
            self.launch.identity().attempt_id.clone(),
        ))?;
        lifecycle.transition(RunnerState::Active)?;

        Ok(PendingActivation::Fresh(Box::new(PendingFreshActivation {
            binding: inbound_binding,
            cache: ActivationCache {
                idempotency_key: request.idempotency_key,
                frame_payload_sha256,
            },
            authority,
            handshake,
            lifecycle,
        })))
    }

    /// Publishes authority only from a receipt-bound activation transition.
    pub(in crate::control) fn install_activation(
        &mut self,
        committed: CommittedActivation,
        clock: Arc<dyn EffectClock>,
    ) -> ActivationOutcome {
        match committed {
            CommittedActivation::Fresh(fresh) => {
                let crate::control::model::FreshActivation {
                    cache,
                    authority,
                    handshake,
                    lifecycle,
                } = *fresh;
                let gate = authority.effect_gate(clock);
                self.activation = Some(cache);
                self.authority = Some(authority);
                self.effect_gate = Some(gate);
                self.handshake = handshake;
                self.lifecycle = lifecycle;
                ActivationOutcome::Activated
            }
            CommittedActivation::Retry => ActivationOutcome::AlreadyActive,
        }
    }

    /// Issues a non-cloneable effect capability only while authority is live.
    ///
    /// # Errors
    ///
    /// Returns an error when no live authority exists.
    #[cfg(test)]
    pub(in crate::control) fn effect_token(&self) -> Result<EffectToken, AuthorityError> {
        self.effect_gate
            .as_ref()
            .ok_or(AuthorityError::NotActive)?
            .token()
    }

    /// Runs the synchronous dispatch boundary under the authority gate.
    ///
    /// # Errors
    ///
    /// Returns an error when the token is stale, foreign, expired, or revoked.
    #[cfg(test)]
    pub(in crate::control) fn with_effect_dispatch<R>(
        &self,
        token: &EffectToken,
        dispatch: impl FnOnce(&EffectDispatchPermit<'_>) -> R,
    ) -> Result<R, AuthorityError> {
        self.effect_gate
            .as_ref()
            .ok_or(AuthorityError::NotActive)?
            .with_effect_dispatch(token, dispatch)
    }

    /// Cancel, fence, lease loss, connection close and deadline paths call this.
    pub fn revoke_effects(&self) {
        if let Some(gate) = &self.effect_gate {
            gate.revoke();
        }
    }
}
