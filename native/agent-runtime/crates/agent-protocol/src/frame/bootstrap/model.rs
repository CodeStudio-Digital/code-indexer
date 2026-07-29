use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId};
use crate::runner_bootstrap::{scrub_agent_hello, scrub_host_hello};
use crate::version::ProtocolVersion;

use super::super::FrameDirection;
use super::{BootstrapError, validate_host_selection};

#[derive(Debug)]
pub enum BootstrapReceiveOutcome {
    AgentHello(BootstrapAgentHello),
    HostHello(BootstrapHostHello),
}

#[derive(Debug)]
pub struct BootstrapAgentHello {
    hello: ScrubbedAgentHello,
    envelope_digest: [u8; 32],
    identity: AttemptIdentity,
    connection: ConnectionId,
    bootstrap_message_id: String,
    bootstrap_channel_id: u64,
    hard_cap: usize,
}

struct ScrubbedAgentHello(wire::AgentHello);

impl Debug for ScrubbedAgentHello {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("AgentHello([NONCE REDACTED])")
    }
}

impl Drop for ScrubbedAgentHello {
    fn drop(&mut self) {
        scrub_agent_hello(&mut self.0);
    }
}

impl BootstrapAgentHello {
    pub(super) const fn new(
        hello: wire::AgentHello,
        envelope_digest: [u8; 32],
        identity: AttemptIdentity,
        connection: ConnectionId,
        bootstrap_message_id: String,
        bootstrap_channel_id: u64,
        hard_cap: usize,
    ) -> Self {
        Self {
            hello: ScrubbedAgentHello(hello),
            envelope_digest,
            identity,
            connection,
            bootstrap_message_id,
            bootstrap_channel_id,
            hard_cap,
        }
    }

    #[must_use]
    pub const fn hello(&self) -> &wire::AgentHello {
        &self.hello.0
    }

    #[must_use]
    pub const fn envelope_digest(&self) -> &[u8; 32] {
        &self.envelope_digest
    }

    /// Consumes the authenticated `AgentHello` and binds the host selection.
    ///
    /// # Errors
    ///
    /// Rejects invalid protocol, connection, or frame limit selections.
    pub fn negotiate(
        self,
        host_hello: &wire::HostHello,
    ) -> Result<NegotiatedReceiverSeed, BootstrapError> {
        let (protocol, connection, maximum) = validate_host_selection(host_hello, self.hard_cap)?;
        if connection != self.connection {
            return Err(BootstrapError::ConnectionMismatch);
        }
        Ok(NegotiatedReceiverSeed {
            protocol,
            connection,
            identity: self.identity,
            channel: wire::TransportChannel::Control,
            direction: FrameDirection::RunnerToHost,
            maximum_frame_bytes: maximum,
            stream_watermark: 1,
            bootstrap_message_id: self.bootstrap_message_id,
            bootstrap_channel_id: self.bootstrap_channel_id,
        })
    }

    pub(super) const fn bootstrap_channel_id(&self) -> u64 {
        self.bootstrap_channel_id
    }
}

pub struct BootstrapHostHello {
    hello: ScrubbedHostHello,
    seed: NegotiatedReceiverSeed,
}

struct ScrubbedHostHello(wire::HostHello);

impl Debug for ScrubbedHostHello {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("HostHello([TOKEN REDACTED])")
    }
}

impl Drop for ScrubbedHostHello {
    fn drop(&mut self) {
        scrub_host_hello(&mut self.0);
    }
}

impl Debug for BootstrapHostHello {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BootstrapHostHello")
            .field("hello", &self.hello)
            .field("seed", &self.seed)
            .finish()
    }
}

impl BootstrapHostHello {
    pub(super) const fn new(hello: wire::HostHello, seed: NegotiatedReceiverSeed) -> Self {
        Self {
            hello: ScrubbedHostHello(hello),
            seed,
        }
    }

    #[must_use]
    pub const fn hello(&self) -> &wire::HostHello {
        &self.hello.0
    }

    #[must_use]
    pub fn into_seed(self) -> NegotiatedReceiverSeed {
        self.seed
    }

    pub(super) const fn bootstrap_channel_id(&self) -> u64 {
        self.seed.bootstrap_channel_id
    }
}

#[derive(Debug)]
pub struct NegotiatedReceiverSeed {
    pub(in crate::frame) protocol: ProtocolVersion,
    pub(in crate::frame) connection: ConnectionId,
    pub(in crate::frame) identity: AttemptIdentity,
    pub(in crate::frame) channel: wire::TransportChannel,
    pub(in crate::frame) direction: FrameDirection,
    pub(in crate::frame) maximum_frame_bytes: usize,
    pub(in crate::frame) stream_watermark: u64,
    pub(in crate::frame) bootstrap_message_id: String,
    pub(in crate::frame) bootstrap_channel_id: u64,
}

impl NegotiatedReceiverSeed {
    #[must_use]
    pub const fn protocol(&self) -> ProtocolVersion {
        self.protocol
    }

    #[must_use]
    pub fn connection_id(&self) -> &str {
        self.connection.as_str()
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> usize {
        self.maximum_frame_bytes
    }

    #[must_use]
    pub const fn channel(&self) -> wire::TransportChannel {
        self.channel
    }

    #[must_use]
    pub const fn stream_watermark(&self) -> u64 {
        self.stream_watermark
    }
}
