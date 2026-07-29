use agent_protocol::handshake::HandshakeMachine;

use crate::lifecycle::{RunnerLifecycle, RunnerState};

use super::authority::{ActiveAuthority, EffectGate};
use super::error::ControlError;
use super::hello::{AgentHelloContext, ConnectionContext};
use super::launch::RunnerLaunchContext;
use super::model::{AcceptedTermination, ActivationCache, PreparationState};

mod activate;
mod context;
mod handshake;
mod prepare;
mod termination;

/// Deterministic, single-tenant control session for one launched attempt.
#[derive(Debug)]
pub struct RunnerControlSession {
    pub(super) lifecycle: RunnerLifecycle,
    pub(super) handshake: HandshakeMachine,
    pub(super) launch: RunnerLaunchContext,
    pub(super) agent_hello: Option<AgentHelloContext>,
    pub(super) connection: Option<ConnectionContext>,
    pub(super) preparation: Option<PreparationState>,
    pub(super) activation: Option<ActivationCache>,
    pub(super) termination: Option<AcceptedTermination>,
    pub(super) authority: Option<ActiveAuthority>,
    pub(super) effect_gate: Option<EffectGate>,
    pub(super) next_hydration_seal: u64,
}

impl RunnerControlSession {
    /// Consumes the trusted, single-use process bootstrap authority.
    ///
    /// # Errors
    ///
    /// Returns an error when the trusted launch identity cannot enter the
    /// spawning lifecycle.
    pub(in crate::control) fn new(launch: RunnerLaunchContext) -> Result<Self, ControlError> {
        let mut lifecycle = RunnerLifecycle::default();
        lifecycle.assign(launch.identity().clone())?;
        lifecycle.transition(RunnerState::Spawning)?;
        Ok(Self {
            lifecycle,
            handshake: HandshakeMachine::default(),
            launch,
            agent_hello: None,
            connection: None,
            preparation: None,
            activation: None,
            termination: None,
            authority: None,
            effect_gate: None,
            next_hydration_seal: 1,
        })
    }

    #[must_use]
    pub const fn state(&self) -> RunnerState {
        self.lifecycle.state()
    }

    #[must_use]
    pub(in crate::control) const fn prepared_response(
        &self,
    ) -> Option<&agent_protocol::generated::v1::FramePayload> {
        match self.preparation.as_ref() {
            Some(PreparationState::Prepared(cache)) => Some(&cache.response),
            _ => None,
        }
    }

    pub(in crate::control) fn effective_deadline_at_unix_ms(&self) -> i64 {
        let mut deadline = self.launch.hard_deadline_at_unix_ms();
        if let Some(preparation) = &self.preparation {
            let prepared_deadline = match preparation {
                PreparationState::Hydrating(pending) => pending.immutable_deadline_at_unix_ms,
                PreparationState::Prepared(prepared) => prepared.immutable_deadline_at_unix_ms,
            };
            deadline = deadline.min(prepared_deadline);
        }
        if let Some(authority) = &self.authority {
            deadline = deadline.min(authority.deadline_at_unix_ms());
        }
        deadline
    }

    pub(in crate::control) fn connection_lost(&mut self) {
        self.revoke_effects();
        self.handshake = HandshakeMachine::default();
        self.agent_hello = None;
        self.connection = None;
        self.preparation = None;
        self.activation = None;
        self.termination = None;
        self.authority = None;
        self.effect_gate = None;
        let _ignored = self.lifecycle.force_exit();
    }
}
