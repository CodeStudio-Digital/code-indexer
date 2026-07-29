use std::fmt::{self, Debug, Formatter};
use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId};

use super::super::sender::encode_bootstrap_hello;
use super::super::{
    AsyncEstablishedAttemptChannel, AttemptFrameReceiver, FrameDirection, OutboundFrameError,
    ScrubbedFrameBody,
};
use super::{BootstrapError, BootstrapReceiveOutcome, BootstrapReceiver, NegotiatedReceiverSeed};

mod construction;
mod error;
mod hello;
mod operation;
pub use error::AsyncBootstrapChannelError;
use hello::agent_hello_protocol;
use operation::AsyncBootstrapOperation;

/// Runner-side one-shot Hello owner over one bounded async byte stream.
pub struct AsyncBootstrapAttemptChannel<S> {
    transport: AsyncDelimitedFrameChannel<S>,
    receiver: BootstrapReceiver,
    accepted_channel_id: Option<u64>,
    expected_identity: AttemptIdentity,
    expected_connection: ConnectionId,
    hard_cap: usize,
    outbound_hello_sent: bool,
}

impl<S> Debug for AsyncBootstrapAttemptChannel<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncBootstrapAttemptChannel")
            .field("transport", &self.transport)
            .field("receiver", &self.receiver)
            .field("outbound_hello_sent", &self.outbound_hello_sent)
            .finish_non_exhaustive()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncBootstrapAttemptChannel<S> {
    pub(crate) fn send_owned_agent_hello<'a, F>(
        &'a mut self,
        hello: wire::AgentHello,
        deadline: Instant,
        clock: F,
    ) -> impl Future<Output = Result<(), AsyncBootstrapChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let body = ScrubbedFrameBody::new(wire::frame_payload::Body::AgentHello(hello));
        let mut operation = AsyncBootstrapOperation::new(self);
        async move {
            let result = operation
                .channel()
                .send_owned_agent_hello_inner(body, deadline, clock)
                .await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn send_owned_agent_hello_inner<F>(
        &mut self,
        mut body: ScrubbedFrameBody,
        deadline: Instant,
        clock: F,
    ) -> Result<(), AsyncBootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        if self.outbound_hello_sent {
            self.poison();
            return Err(AsyncBootstrapChannelError::Outbound(
                OutboundFrameError::BootstrapAlreadySent,
            ));
        }
        let wire::frame_payload::Body::AgentHello(hello) = body.as_ref() else {
            unreachable!("owned AgentHello body changed variant")
        };
        let protocol = match agent_hello_protocol(hello) {
            Ok(value) => value,
            Err(error) => {
                self.poison();
                return Err(error);
            }
        };
        let encoded = match encode_bootstrap_hello(
            protocol,
            &self.expected_connection,
            &self.expected_identity,
            FrameDirection::RunnerToHost,
            body.take(),
            self.hard_cap,
            clock,
        ) {
            Ok(value) => Zeroizing::new(value),
            Err(error) => {
                self.poison();
                return Err(AsyncBootstrapChannelError::Outbound(error));
            }
        };
        if let Err(error) = self.transport.send(encoded.as_slice(), deadline).await {
            self.receiver.invalidate();
            return Err(AsyncBootstrapChannelError::Framing(error));
        }
        self.outbound_hello_sent = true;
        Ok(())
    }

    /// Receives the one authenticated `HostHello`.
    ///
    /// # Errors
    ///
    /// Fails closed on ordering, framing, deadline, or semantic validation.
    pub fn receive<'a, F>(
        &'a mut self,
        deadline: Instant,
        clock: F,
    ) -> impl Future<Output = Result<BootstrapReceiveOutcome, AsyncBootstrapChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let mut operation = AsyncBootstrapOperation::new(self);
        async move {
            let result = operation.channel().receive_inner(deadline, clock).await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn receive_inner<F>(
        &mut self,
        deadline: Instant,
        clock: F,
    ) -> Result<BootstrapReceiveOutcome, AsyncBootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        if !self.outbound_hello_sent {
            self.poison();
            return Err(AsyncBootstrapChannelError::MissingOutboundHello);
        }
        if self.receiver.is_consumed() {
            self.poison();
            return Err(AsyncBootstrapChannelError::Bootstrap(
                BootstrapError::Consumed,
            ));
        }
        let encoded = match self.transport.receive(deadline).await {
            Ok(encoded) => Zeroizing::new(encoded),
            Err(error) => {
                self.receiver.invalidate();
                return Err(AsyncBootstrapChannelError::Framing(error));
            }
        };
        match self.receiver.receive(encoded.as_slice(), clock) {
            Ok(outcome) => {
                self.accepted_channel_id = Some(match &outcome {
                    BootstrapReceiveOutcome::AgentHello(hello) => hello.bootstrap_channel_id(),
                    BootstrapReceiveOutcome::HostHello(hello) => hello.bootstrap_channel_id(),
                });
                Ok(outcome)
            }
            Err(error) => {
                self.transport.poison();
                Err(AsyncBootstrapChannelError::Bootstrap(error))
            }
        }
    }

    /// Narrows the same stream into established attempt framing.
    ///
    /// # Errors
    ///
    /// Rejects a foreign seed, invalid capacities, or a failed cap handoff.
    pub fn into_established(
        mut self,
        seed: NegotiatedReceiverSeed,
        replay_capacity: usize,
        total_identity_capacity: usize,
        max_replay_bytes: usize,
    ) -> Result<AsyncEstablishedAttemptChannel<S>, AsyncBootstrapChannelError> {
        if self.accepted_channel_id != Some(seed.bootstrap_channel_id) {
            self.poison();
            return Err(AsyncBootstrapChannelError::SeedChannelMismatch);
        }
        let negotiated = seed.maximum_frame_bytes;
        let receiver = AttemptFrameReceiver::from_seed(
            seed,
            replay_capacity,
            total_identity_capacity,
            max_replay_bytes,
        )
        .map_err(AsyncBootstrapChannelError::Handoff)?;
        let sender = receiver
            .outbound_authority(1)
            .map_err(AsyncBootstrapChannelError::Outbound)?;
        let maximum = u32::try_from(negotiated)
            .map_err(|_| AsyncBootstrapChannelError::Bootstrap(BootstrapError::InvalidHardCap))?;
        let transport = self
            .transport
            .narrow(maximum)
            .map_err(AsyncBootstrapChannelError::Framing)?;
        AsyncEstablishedAttemptChannel::from_handoff(transport, receiver, sender)
            .map_err(AsyncBootstrapChannelError::Established)
    }

    pub(super) fn poison(&mut self) {
        self.receiver.invalidate();
        self.transport.poison();
    }
}
