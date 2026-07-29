use std::fmt::{self, Debug, Formatter};

use tokio::sync::{mpsc, oneshot};

use super::AsyncManagementActorError;
use super::command::{AsyncQueuedManagementWrite, AsyncSentManagementFrame};
use crate::generated::v1 as wire;
use crate::management_channel::{
    CommittedManagementInbound, ManagementPayloadKind, PendingManagementInbound,
    ReplayedManagementFrame,
};
use crate::management_secrets::scrub_protected_body;

#[derive(Debug)]
pub enum AsyncManagementEvent {
    Pending(AsyncPendingManagementInbound),
    Acknowledged(AsyncAcknowledgedManagementInbound),
    Replay(ReplayedManagementFrame),
}

/// Committed inbound ACK with the validated correlation body preserved.
///
/// The actor commits the frame exactly once before publishing this value.
/// Consumers can advance their domain fact ledger without recovering or
/// decoding peer-controlled bytes outside the protocol owner.
#[derive(Debug)]
pub struct AsyncAcknowledgedManagementInbound {
    committed: CommittedManagementInbound,
    acknowledgement: wire::ManagementAck,
}

impl AsyncAcknowledgedManagementInbound {
    pub(super) const fn new(
        committed: CommittedManagementInbound,
        acknowledgement: wire::ManagementAck,
    ) -> Self {
        Self {
            committed,
            acknowledgement,
        }
    }

    #[must_use]
    pub const fn committed(&self) -> &CommittedManagementInbound {
        &self.committed
    }

    #[must_use]
    pub const fn acknowledgement(&self) -> &wire::ManagementAck {
        &self.acknowledgement
    }

    #[must_use]
    pub fn into_parts(self) -> (CommittedManagementInbound, wire::ManagementAck) {
        (self.committed, self.acknowledgement)
    }
}

pub struct AsyncPendingManagementInbound {
    pending: Option<Box<PendingManagementInbound>>,
    resolution: Option<oneshot::Sender<InboundResolution>>,
    durable_ack_required: bool,
}

impl Debug for AsyncPendingManagementInbound {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncPendingManagementInbound")
            .field("pending", &self.pending)
            .finish_non_exhaustive()
    }
}

impl AsyncPendingManagementInbound {
    pub(super) fn new(
        pending: Box<PendingManagementInbound>,
        durable_ack_required: bool,
    ) -> (Self, oneshot::Receiver<InboundResolution>) {
        let (resolution, receiver) = oneshot::channel();
        (
            Self {
                pending: Some(pending),
                resolution: Some(resolution),
                durable_ack_required,
            },
            receiver,
        )
    }

    /// # Panics
    ///
    /// Panics only if the private single-use invariant is violated internally.
    #[must_use]
    pub fn kind(&self) -> ManagementPayloadKind {
        self.pending
            .as_deref()
            .expect("pending inbound remains until resolved")
            .kind()
    }

    /// # Panics
    ///
    /// Panics only if the private single-use invariant is violated internally.
    pub fn pending_mut(&mut self) -> &mut PendingManagementInbound {
        self.pending
            .as_deref_mut()
            .expect("pending inbound remains until resolved")
    }

    /// # Errors
    ///
    /// Rejects owner-clock ACK forgery, duplicate resolution, or a closed actor.
    pub fn respond(
        mut self,
        payload: wire::ManagementPayload,
    ) -> Result<AsyncQueuedManagementWrite, AsyncManagementActorError> {
        let payload = Box::new(GuardedResponsePayload::new(payload));
        if matches!(
            payload.get().body,
            Some(wire::management_payload::Body::ManagementAck(_))
        ) {
            return Err(
                crate::management_channel::ManagementChannelError::InvalidManagementPayload {
                    payload: "ManagementAck",
                    field: "owner_clock_required",
                }
                .into(),
            );
        }
        let (written, receiver) = oneshot::channel();
        self.resolve(InboundResolutionKind::Respond(payload), Some(written))?;
        Ok(AsyncQueuedManagementWrite::new(receiver))
    }

    /// Signals that durable commit completed; the actor builds the ACK using
    /// its private message binding, digest, sequence, and monotonic clock.
    ///
    /// # Errors
    ///
    /// The host requires an owner-issued durable receipt; closed and duplicate
    /// resolutions also fail.
    pub fn acknowledge(mut self) -> Result<AsyncQueuedManagementWrite, AsyncManagementActorError> {
        if self.durable_ack_required {
            return Err(AsyncManagementActorError::DurableCommitReceiptRequired);
        }
        let (written, receiver) = oneshot::channel();
        self.resolve(InboundResolutionKind::Acknowledge, Some(written))?;
        Ok(AsyncQueuedManagementWrite::new(receiver))
    }

    /// # Errors
    ///
    /// Fails if this inbound was already resolved or the actor is closed.
    pub fn reject(mut self) -> Result<(), AsyncManagementActorError> {
        self.resolve(InboundResolutionKind::Reject, None)
    }

    fn resolve(
        &mut self,
        kind: InboundResolutionKind,
        written: Option<
            oneshot::Sender<Result<AsyncSentManagementFrame, AsyncManagementActorError>>,
        >,
    ) -> Result<(), AsyncManagementActorError> {
        let pending = self
            .pending
            .take()
            .ok_or(AsyncManagementActorError::PendingInboundAbandoned)?;
        let resolution = InboundResolution {
            pending,
            kind,
            written,
        };
        self.resolution
            .take()
            .ok_or(AsyncManagementActorError::PendingInboundAbandoned)?
            .send(resolution)
            .map_err(|_| AsyncManagementActorError::ActorClosed)
    }
}

pub(super) struct InboundResolution {
    pub pending: Box<PendingManagementInbound>,
    pub kind: InboundResolutionKind,
    pub written:
        Option<oneshot::Sender<Result<AsyncSentManagementFrame, AsyncManagementActorError>>>,
}

pub(super) enum InboundResolutionKind {
    Respond(Box<GuardedResponsePayload>),
    Acknowledge,
    Reject,
}

pub(super) struct GuardedResponsePayload(Option<wire::ManagementPayload>);

impl GuardedResponsePayload {
    const fn new(payload: wire::ManagementPayload) -> Self {
        Self(Some(payload))
    }

    const fn get(&self) -> &wire::ManagementPayload {
        self.0.as_ref().expect("response payload is present")
    }

    pub(super) fn take(mut self) -> wire::ManagementPayload {
        self.0.take().expect("response payload is consumed once")
    }
}

impl Drop for GuardedResponsePayload {
    fn drop(&mut self) {
        if let Some(payload) = &mut self.0
            && let Some(body) = &mut payload.body
        {
            scrub_protected_body(body);
        }
    }
}

pub(super) struct EventQueue {
    receiver: mpsc::Receiver<Result<AsyncManagementEvent, AsyncManagementActorError>>,
}

pub(super) type EventSender = mpsc::Sender<Result<AsyncManagementEvent, AsyncManagementActorError>>;

impl EventQueue {
    pub(super) fn new(capacity: usize) -> (EventSender, Self) {
        let (sender, receiver) = mpsc::channel(capacity);
        (sender, Self { receiver })
    }

    pub(super) async fn receive(
        &mut self,
    ) -> Option<Result<AsyncManagementEvent, AsyncManagementActorError>> {
        self.receiver.recv().await
    }
}
