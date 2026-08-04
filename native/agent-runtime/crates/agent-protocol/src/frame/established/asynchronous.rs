use std::fmt::{self, Debug, Formatter};
use std::future::Future;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::framing::asynchronous::AsyncDelimitedFrameChannel;
use crate::generated::v1 as wire;

use super::super::sender::OutboundHeaderAuthority;
use super::super::{
    AttemptFrameReceiver, BoundedReplayOutcome, CommittedResponse, FrameReceiveOutcome,
    InboundFrameError, PendingInbound,
};

mod error;
mod idle;
mod operation;
pub use error::AsyncEstablishedChannelError;
pub use idle::ActiveFrameReceiveOutcome;
use operation::AsyncEstablishedOperation;

/// Async owner of one negotiated attempt stream and both semantic directions.
///
/// Physical I/O is removed from the owner before every await. Cancelling an
/// operation therefore drops the stream and leaves this channel poisoned.
pub struct AsyncEstablishedAttemptChannel<S> {
    transport: AsyncDelimitedFrameChannel<S>,
    receiver: AttemptFrameReceiver,
    sender: OutboundHeaderAuthority,
}

impl<S> Debug for AsyncEstablishedAttemptChannel<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncEstablishedAttemptChannel")
            .field("transport", &self.transport)
            .field("receiver", &self.receiver)
            .field("sender", &self.sender)
            .finish()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncEstablishedAttemptChannel<S> {
    pub(in crate::frame) fn from_handoff(
        mut transport: AsyncDelimitedFrameChannel<S>,
        receiver: AttemptFrameReceiver,
        sender: OutboundHeaderAuthority,
    ) -> Result<Self, AsyncEstablishedChannelError> {
        let physical = transport.maximum_frame_bytes();
        if usize::try_from(physical).unwrap_or(usize::MAX) != receiver.maximum_frame_bytes() {
            transport.poison();
            return Err(AsyncEstablishedChannelError::PhysicalCapMismatch {
                physical,
                negotiated: receiver.maximum_frame_bytes(),
            });
        }
        Ok(Self {
            transport,
            receiver,
            sender,
        })
    }

    /// Receives one bounded frame and handles exact replay responses.
    ///
    /// # Errors
    ///
    /// Fails closed on timeout, cancellation, framing, or semantic rejection.
    pub fn begin_receive<'a, F>(
        &'a mut self,
        read_deadline: Instant,
        replay_hard_deadline: Instant,
        replay_write_timeout: Duration,
        clock: F,
    ) -> impl Future<Output = Result<FrameReceiveOutcome, AsyncEstablishedChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let mut operation = AsyncEstablishedOperation::new(self);
        async move {
            let result = operation
                .channel()
                .begin_receive_inner(
                    read_deadline,
                    replay_hard_deadline,
                    replay_write_timeout,
                    clock,
                )
                .await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn begin_receive_inner<F>(
        &mut self,
        read_deadline: Instant,
        replay_hard_deadline: Instant,
        replay_write_timeout: Duration,
        clock: F,
    ) -> Result<FrameReceiveOutcome, AsyncEstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        if self.receiver.has_pending() {
            return Err(AsyncEstablishedChannelError::Inbound(
                InboundFrameError::PendingInboundActive,
            ));
        }
        let encoded = match self.transport.receive(read_deadline).await {
            Ok(encoded) => Zeroizing::new(encoded),
            Err(error) => {
                self.receiver.poison();
                self.sender.poison();
                return Err(AsyncEstablishedChannelError::Framing(error));
            }
        };
        let outcome = match self.receiver.begin_receive(encoded.as_slice(), clock) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.transport.poison();
                self.sender.poison();
                return Err(AsyncEstablishedChannelError::Inbound(error));
            }
        };
        if let FrameReceiveOutcome::Replay(replay) = &outcome {
            let replay_write_deadline = Instant::now()
                .checked_add(replay_write_timeout)
                .map_or(replay_hard_deadline, |deadline| {
                    deadline.min(replay_hard_deadline)
                });
            let response = self
                .receiver
                .take_replay_response(replay)
                .map_err(|error| {
                    self.poison_all();
                    AsyncEstablishedChannelError::Inbound(error)
                })?;
            if let Some(response) = response
                && let Err(error) = self.transport.send(&response, replay_write_deadline).await
            {
                self.receiver.poison();
                self.sender.poison();
                return Err(AsyncEstablishedChannelError::Framing(error));
            }
        }
        Ok(outcome)
    }

    /// Commits an inbound response only after its physical write completes.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid binding, outbound authority, or physical write.
    pub fn commit_response<'a, F>(
        &'a mut self,
        inbound: PendingInbound,
        payload: &'a wire::FramePayload,
        semantic_deadline_at_unix_ms: i64,
        physical_deadline: Instant,
        clock: F,
    ) -> impl Future<Output = Result<CommittedResponse, AsyncEstablishedChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let mut operation = AsyncEstablishedOperation::new(self);
        async move {
            let result = operation
                .channel()
                .commit_response_inner(
                    inbound,
                    payload,
                    semantic_deadline_at_unix_ms,
                    physical_deadline,
                    clock,
                )
                .await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn commit_response_inner<F>(
        &mut self,
        inbound: PendingInbound,
        payload: &wire::FramePayload,
        semantic_deadline_at_unix_ms: i64,
        physical_deadline: Instant,
        clock: F,
    ) -> Result<CommittedResponse, AsyncEstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        let reply_to = inbound.message_id().to_owned();
        let outbound = self
            .sender
            .prepare(payload, reply_to, semantic_deadline_at_unix_ms, clock)
            .map_err(|error| {
                self.poison_all();
                AsyncEstablishedChannelError::Outbound(error)
            })?;
        self.sender.validate(&outbound).map_err(|error| {
            self.poison_all();
            AsyncEstablishedChannelError::Outbound(error)
        })?;
        let response = outbound.shared();
        let outcome = BoundedReplayOutcome::from_shared_response(response.clone());
        let receipt = self.receiver.commit(inbound, outcome).map_err(|error| {
            self.transport.poison();
            self.sender.poison();
            AsyncEstablishedChannelError::Inbound(error)
        })?;
        if let Err(error) = self.transport.send(&response, physical_deadline).await {
            self.receiver.poison();
            self.sender.poison();
            return Err(AsyncEstablishedChannelError::Framing(error));
        }
        self.sender.commit(outbound);
        Ok(CommittedResponse::new(receipt))
    }

    /// Sends a fresh unsolicited payload under the channel-owned sequence.
    ///
    /// The frame has no `reply_to_message_id`. Header authority commits only
    /// after the physical write succeeds; cancellation poisons the channel.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid direction, authority, deadline, or write.
    pub fn send_new<'a, F>(
        &'a mut self,
        payload: &'a wire::FramePayload,
        semantic_deadline_at_unix_ms: i64,
        physical_deadline: Instant,
        clock: F,
    ) -> impl Future<Output = Result<(), AsyncEstablishedChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let mut operation = AsyncEstablishedOperation::new(self);
        async move {
            let result = operation
                .channel()
                .send_new_inner(
                    payload,
                    semantic_deadline_at_unix_ms,
                    physical_deadline,
                    clock,
                )
                .await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn send_new_inner<F>(
        &mut self,
        payload: &wire::FramePayload,
        semantic_deadline_at_unix_ms: i64,
        physical_deadline: Instant,
        clock: F,
    ) -> Result<(), AsyncEstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        let outbound = self
            .sender
            .prepare_new(payload, semantic_deadline_at_unix_ms, clock)
            .map_err(|error| {
                self.poison_all();
                AsyncEstablishedChannelError::Outbound(error)
            })?;
        self.sender.validate(&outbound).map_err(|error| {
            self.poison_all();
            AsyncEstablishedChannelError::Outbound(error)
        })?;
        let encoded = outbound.shared();
        if let Err(error) = self.transport.send(&encoded, physical_deadline).await {
            self.receiver.poison();
            self.sender.poison();
            return Err(AsyncEstablishedChannelError::Framing(error));
        }
        self.sender.commit(outbound);
        Ok(())
    }

    /// Rejects the pending inbound and permanently poisons the channel.
    ///
    /// # Errors
    ///
    /// Returns the semantic rejection error after closing all channel owners.
    pub fn reject(&mut self, pending: PendingInbound) -> Result<(), AsyncEstablishedChannelError> {
        let result = self.receiver.reject(pending);
        self.poison_all();
        result.map_err(AsyncEstablishedChannelError::Inbound)
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.transport.is_poisoned() || self.receiver.is_poisoned() || self.sender.is_poisoned()
    }

    fn poison_all(&mut self) {
        self.receiver.poison();
        self.sender.poison();
        self.transport.poison();
    }
}
