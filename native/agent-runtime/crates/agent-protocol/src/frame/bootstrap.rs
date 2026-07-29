use std::sync::atomic::{AtomicU64, Ordering};

use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId};
use crate::version::ProtocolVersion;
use crate::wire_identity::{
    WireIdentityError, validate_required_identifier, validate_semantic_identity,
};

use super::{
    CONTROL_FRAME_MAX_BYTES, FrameDirection, ScrubbedFrameBody, decode_attempt_payload,
    validate_opaque_envelope,
};

mod asynchronous;
mod channel;
mod error;
mod model;

pub use asynchronous::{AsyncBootstrapAttemptChannel, AsyncBootstrapChannelError};
pub use channel::{BootstrapAttemptChannel, BootstrapChannelError};
pub use error::BootstrapError;
pub use model::{
    BootstrapAgentHello, BootstrapHostHello, BootstrapReceiveOutcome, NegotiatedReceiverSeed,
};

static NEXT_BOOTSTRAP_CHANNEL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
pub struct BootstrapReceiver {
    channel_id: u64,
    expected_identity: AttemptIdentity,
    expected_connection: ConnectionId,
    direction: FrameDirection,
    hard_cap: usize,
    consumed: bool,
}

impl BootstrapReceiver {
    /// Creates a one-shot control-channel bootstrap receiver.
    ///
    /// # Errors
    ///
    /// Rejects invalid launch authority or hard caps.
    pub fn new(
        expected_identity: AttemptIdentity,
        expected_connection: ConnectionId,
        direction: FrameDirection,
        hard_cap: usize,
    ) -> Result<Self, BootstrapError> {
        validate_semantic_identity(&expected_identity)
            .map_err(BootstrapError::InvalidExpectedIdentity)?;
        validate_required_identifier(expected_connection.as_str(), "connection_id")
            .map_err(BootstrapError::InvalidSelectedConnection)?;
        if hard_cap == 0 || hard_cap > CONTROL_FRAME_MAX_BYTES {
            return Err(BootstrapError::InvalidHardCap);
        }
        let channel_id = NEXT_BOOTSTRAP_CHANNEL_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                current.checked_add(1)
            })
            .map_err(|_| BootstrapError::ChannelIdExhausted)?;
        Ok(Self {
            channel_id,
            expected_identity,
            expected_connection,
            direction,
            hard_cap,
            consumed: false,
        })
    }

    /// Consumes exactly one Hello envelope and cannot be reused.
    ///
    /// # Errors
    ///
    /// Rejects non-Hello payloads, stale authority, invalid sequence/deadline,
    /// and inconsistent `HostHello` negotiation facts.
    pub fn receive<F>(
        &mut self,
        encoded_frame: &[u8],
        clock: F,
    ) -> Result<BootstrapReceiveOutcome, BootstrapError>
    where
        F: FnOnce() -> i64,
    {
        if self.consumed {
            return Err(BootstrapError::Consumed);
        }
        self.consumed = true;
        let observed_at_unix_ms = clock();
        if observed_at_unix_ms <= 0 {
            return Err(BootstrapError::InvalidObservedAt(observed_at_unix_ms));
        }
        let opaque = validate_opaque_envelope(
            encoded_frame,
            wire::TransportChannel::Control,
            self.hard_cap,
        )?;
        if opaque.identity != self.expected_identity {
            return Err(BootstrapError::AuthorityMismatch);
        }
        if opaque.connection_id != self.expected_connection {
            return Err(BootstrapError::ConnectionMismatch);
        }
        if opaque.header.stream_seq != 1 {
            return Err(BootstrapError::WrongSequence(opaque.header.stream_seq));
        }
        if let Some(deadline_at) = opaque.header.deadline_at_unix_ms
            && observed_at_unix_ms >= deadline_at
        {
            return Err(BootstrapError::DeadlineExpired {
                deadline_at,
                observed_at: observed_at_unix_ms,
            });
        }
        let validated = decode_attempt_payload(opaque)?;
        let super::ValidatedAttemptFrame {
            body,
            protocol_version,
            connection_id,
            message_id,
            identity,
            envelope_digest,
            ..
        } = validated;
        let mut body = ScrubbedFrameBody::new(body);
        match (self.direction, body.as_ref()) {
            (FrameDirection::RunnerToHost, wire::frame_payload::Body::AgentHello(_)) => {
                let bootstrap_message_id = message_id.as_str().to_owned();
                let wire::frame_payload::Body::AgentHello(hello) = body.take() else {
                    unreachable!("validated AgentHello changed variant")
                };
                Ok(BootstrapReceiveOutcome::AgentHello(
                    BootstrapAgentHello::new(
                        hello,
                        envelope_digest,
                        identity,
                        connection_id,
                        bootstrap_message_id,
                        self.channel_id,
                        self.hard_cap,
                    ),
                ))
            }
            (FrameDirection::HostToRunner, wire::frame_payload::Body::HostHello(hello)) => {
                let seed = self.validate_host_hello(
                    hello,
                    protocol_version,
                    &connection_id,
                    identity,
                    message_id.as_str(),
                )?;
                let wire::frame_payload::Body::HostHello(hello) = body.take() else {
                    unreachable!("validated HostHello changed variant")
                };
                Ok(BootstrapReceiveOutcome::HostHello(BootstrapHostHello::new(
                    hello, seed,
                )))
            }
            _ => Err(BootstrapError::WrongPayload),
        }
    }

    fn validate_host_hello(
        &self,
        hello: &wire::HostHello,
        protocol_version: ProtocolVersion,
        connection_id: &ConnectionId,
        identity: AttemptIdentity,
        message_id: &str,
    ) -> Result<NegotiatedReceiverSeed, BootstrapError> {
        let (protocol, connection, maximum) = validate_host_selection(hello, self.hard_cap)?;
        if protocol != protocol_version {
            return Err(BootstrapError::ProtocolMismatch);
        }
        if &connection != connection_id {
            return Err(BootstrapError::ConnectionMismatch);
        }
        Ok(NegotiatedReceiverSeed {
            protocol,
            connection,
            identity,
            channel: wire::TransportChannel::Control,
            direction: self.direction,
            maximum_frame_bytes: maximum,
            stream_watermark: 1,
            bootstrap_message_id: message_id.to_owned(),
            bootstrap_channel_id: self.channel_id,
        })
    }

    #[must_use]
    pub const fn is_consumed(&self) -> bool {
        self.consumed
    }

    pub(super) const fn invalidate(&mut self) {
        self.consumed = true;
    }
}

fn validate_host_selection(
    hello: &wire::HostHello,
    hard_cap: usize,
) -> Result<(ProtocolVersion, ConnectionId, usize), BootstrapError> {
    let selected = hello
        .selected_protocol
        .as_ref()
        .ok_or(BootstrapError::MissingSelectedProtocol)?;
    let major =
        u16::try_from(selected.major).map_err(|_| BootstrapError::InvalidSelectedProtocol)?;
    let minor =
        u16::try_from(selected.minor).map_err(|_| BootstrapError::InvalidSelectedProtocol)?;
    let protocol = ProtocolVersion::new(major, minor);
    if protocol.major == 0 {
        return Err(BootstrapError::InvalidSelectedProtocol);
    }
    validate_required_identifier(&hello.connection_id, "connection_id")
        .map_err(BootstrapError::InvalidSelectedConnection)?;
    let connection = ConnectionId::new(hello.connection_id.clone()).map_err(|source| {
        BootstrapError::InvalidSelectedConnection(WireIdentityError::InvalidField {
            field: "connection_id",
            source,
        })
    })?;
    let limits = hello
        .frame_limits
        .as_ref()
        .ok_or(BootstrapError::MissingFrameLimits)?;
    let maximum = usize::try_from(limits.max_frame_bytes)
        .map_err(|_| BootstrapError::InvalidNegotiatedMaximum)?;
    if maximum == 0 || maximum > hard_cap {
        return Err(BootstrapError::InvalidNegotiatedMaximum);
    }
    Ok((protocol, connection, maximum))
}
