use agent_protocol::frame::InboundBinding;
use agent_protocol::generated::v1 as wire;
use agent_protocol::handshake::HandshakeEvent;

use crate::lifecycle::RunnerState;

use super::RunnerControlSession;
use crate::control::effective::validate_hydrated_facts;
use crate::control::error::ControlError;
use crate::control::model::{
    CommittedPrepared, EffectivePreparedFacts, HydrationToken, PendingPreparation, PendingPrepared,
    PreparationState, PrepareOutcome,
};
use crate::control::validation::validate_prepare;

impl RunnerControlSession {
    /// Accepts one context-bound Prepare and authorizes hydration, but no effect.
    ///
    /// # Errors
    ///
    /// Returns an error when the frame, resolved spec, identity, budget, or
    /// lifecycle transition is invalid.
    pub(in crate::control) fn begin_prepare(
        &mut self,
        request: wire::PrepareAttempt,
        frame_payload_sha256: [u8; 32],
        inbound_binding: InboundBinding,
        observed_at_unix_ms: i64,
    ) -> Result<PrepareOutcome, ControlError> {
        if let Some(state) = &self.preparation {
            return Self::prepare_retry(state, &request, &frame_payload_sha256);
        }

        let validated = validate_prepare(&request, &self.launch, observed_at_unix_ms)?;
        let mut handshake = self.handshake.clone();
        let mut lifecycle = self.lifecycle.clone();
        handshake.apply(HandshakeEvent::PrepareAccepted(
            validated.identity.attempt_id.clone(),
        ))?;
        lifecycle.transition(RunnerState::Hydrating)?;

        let seal = self.next_hydration_seal;
        self.next_hydration_seal = self.next_hydration_seal.saturating_add(1);
        let token_binding = inbound_binding.clone();
        self.preparation = Some(PreparationState::Hydrating(Box::new(PendingPreparation {
            idempotency_key: request.idempotency_key,
            frame_payload_sha256,
            seal,
            inbound_binding,
            accepted_at_unix_ms: observed_at_unix_ms,
            immutable_deadline_at_unix_ms: validated.immutable_deadline_at_unix_ms,
            spec_sha256: validated.spec_sha256,
            wire_identity: validated.wire_identity,
        })));
        self.handshake = handshake;
        self.lifecycle = lifecycle;
        Ok(PrepareOutcome::HydrationRequired(HydrationToken {
            seal,
            inbound_binding: token_binding,
            expected_snapshots: validated.expected_snapshots,
            expected_artifacts: validated.expected_artifacts,
        }))
    }

    /// Builds the exact Prepared transition without publishing it.
    ///
    /// # Errors
    ///
    /// Returns an error when hydration facts differ from the accepted spec or
    /// when the complete response frame cannot fit the negotiated transport.
    #[allow(clippy::needless_pass_by_value)]
    pub(in crate::control) fn plan_finish_prepare(
        &self,
        token: HydrationToken,
        facts: EffectivePreparedFacts,
        now_unix_ms: i64,
    ) -> Result<PendingPrepared, ControlError> {
        let Some(PreparationState::Hydrating(pending)) = self.preparation.as_ref() else {
            return Err(ControlError::PrepareNotHydrating);
        };
        if token.seal != pending.seal || !token.inbound_binding.matches(&pending.inbound_binding) {
            return Err(ControlError::InvalidHydrationToken);
        }
        validate_hydrated_facts(
            &facts,
            &self.launch,
            &token.expected_snapshots,
            &token.expected_artifacts,
            pending.accepted_at_unix_ms,
            pending.immutable_deadline_at_unix_ms,
            now_unix_ms,
        )?;
        let response = prepared_response(&self.launch, pending, facts);
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::AttemptPrepared(response)),
        };
        let mut handshake = self.handshake.clone();
        let mut lifecycle = self.lifecycle.clone();
        handshake.apply(HandshakeEvent::AttemptPrepared)?;
        lifecycle.transition(RunnerState::Prepared)?;
        Ok(PendingPrepared::new(pending, payload, handshake, lifecycle))
    }

    /// Publishes Prepared only from a receipt-bound transition.
    pub(in crate::control) fn install_prepared(&mut self, committed: CommittedPrepared) {
        self.preparation = Some(PreparationState::Prepared(Box::new(committed.cache)));
        self.handshake = committed.handshake;
        self.lifecycle = committed.lifecycle;
    }

    fn prepare_retry(
        state: &PreparationState,
        request: &wire::PrepareAttempt,
        digest: &[u8; 32],
    ) -> Result<PrepareOutcome, ControlError> {
        let (key, expected) = match state {
            PreparationState::Hydrating(cache) => {
                (&cache.idempotency_key, &cache.frame_payload_sha256)
            }
            PreparationState::Prepared(cache) => {
                (&cache.idempotency_key, &cache.frame_payload_sha256)
            }
        };
        if key != &request.idempotency_key || expected != digest {
            return Err(ControlError::PrepareConflict);
        }
        Ok(match state {
            PreparationState::Hydrating(_) => PrepareOutcome::HydrationInProgress,
            PreparationState::Prepared(_) => PrepareOutcome::AlreadyPrepared,
        })
    }
}

fn prepared_response(
    launch: &crate::control::RunnerLaunchContext,
    pending: &PendingPreparation,
    facts: EffectivePreparedFacts,
) -> wire::AttemptPrepared {
    wire::AttemptPrepared {
        identity: Some(pending.wire_identity.clone()),
        runtime_instance_id: launch.runtime_instance_id().as_str().to_owned(),
        spec_sha256: pending.spec_sha256.to_vec(),
        loaded_snapshots: facts.loaded_snapshots,
        validated_artifacts: facts.validated_artifacts,
        effective_resource_budget: Some(facts.resource_budget),
        effective_containment: Some(facts.containment),
        ready_at_unix_ms: facts.ready_at_unix_ms,
    }
}
