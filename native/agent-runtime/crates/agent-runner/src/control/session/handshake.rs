use agent_protocol::frame::{BootstrapHostHello, NegotiatedReceiverSeed};
use agent_protocol::generated::v1 as wire;
use agent_protocol::handshake::HandshakeEvent;

use crate::lifecycle::RunnerState;

use super::RunnerControlSession;
use crate::control::error::ControlError;
use crate::control::hello::{validate_agent_hello_draft, validate_host_hello};

#[derive(Debug)]
pub(in crate::control) struct PendingAgentHello {
    context: crate::control::hello::AgentHelloContext,
    handshake: agent_protocol::handshake::HandshakeMachine,
    lifecycle: crate::lifecycle::RunnerLifecycle,
}

#[derive(Debug)]
pub(in crate::control) struct PendingHostHello {
    seed: NegotiatedReceiverSeed,
    committed: CommittedHostHello,
}

#[derive(Debug)]
pub(in crate::control) struct CommittedHostHello {
    connection: crate::control::hello::ConnectionContext,
    handshake: agent_protocol::handshake::HandshakeMachine,
}

impl PendingHostHello {
    pub(in crate::control) fn into_parts(self) -> (NegotiatedReceiverSeed, CommittedHostHello) {
        (self.seed, self.committed)
    }
}

impl RunnerControlSession {
    pub(in crate::control) fn plan_agent_hello_draft(
        &self,
        hello: &wire::AgentHello,
    ) -> Result<PendingAgentHello, ControlError> {
        let context = validate_agent_hello_draft(hello, &self.launch)?;
        self.stage_agent_hello(context)
    }

    fn stage_agent_hello(
        &self,
        context: crate::control::hello::AgentHelloContext,
    ) -> Result<PendingAgentHello, ControlError> {
        let mut handshake = self.handshake.clone();
        let mut lifecycle = self.lifecycle.clone();
        handshake.apply(HandshakeEvent::AgentHelloSent)?;
        lifecycle.transition(RunnerState::Handshaking)?;
        Ok(PendingAgentHello {
            context,
            handshake,
            lifecycle,
        })
    }

    /// Publishes the staged Hello state only after its write succeeds.
    pub(in crate::control) fn install_agent_hello(&mut self, pending: PendingAgentHello) {
        self.agent_hello = Some(pending.context);
        self.handshake = pending.handshake;
        self.lifecycle = pending.lifecycle;
    }

    /// Stages a `HostHello` sealed by the one-shot bootstrap receiver.
    ///
    /// # Errors
    ///
    /// Returns an error when negotiation or the bootstrap receiver context
    /// differs from the hello emitted by this attempt.
    pub(in crate::control) fn plan_host_hello(
        &self,
        validated: BootstrapHostHello,
    ) -> Result<PendingHostHello, ControlError> {
        let agent = self
            .agent_hello
            .as_ref()
            .ok_or(ControlError::InvalidHostHello("AgentHello was not sent"))?;
        let connection = validate_host_hello(validated.hello(), agent, &self.launch)?;
        let seed = validated.into_seed();
        if seed.protocol() != connection.negotiated.version
            || seed.connection_id() != connection.connection_id.as_str()
            || seed.maximum_frame_bytes() != connection.max_frame_bytes
        {
            return Err(ControlError::ConnectionContextMismatch);
        }
        let mut handshake = self.handshake.clone();
        handshake.apply(HandshakeEvent::HostHelloAccepted(connection.negotiated))?;
        Ok(PendingHostHello {
            seed,
            committed: CommittedHostHello {
                connection,
                handshake,
            },
        })
    }

    /// Publishes negotiated connection state only after same-stream handoff.
    pub(in crate::control) fn install_host_hello(&mut self, committed: CommittedHostHello) {
        self.connection = Some(committed.connection);
        self.agent_hello = None;
        self.handshake = committed.handshake;
    }
}
