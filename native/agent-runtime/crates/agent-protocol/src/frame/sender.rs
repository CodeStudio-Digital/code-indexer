use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId};
use crate::version::ProtocolVersion;
use crate::wire_identity::identity_to_wire;

use super::direction::validate_payload_direction;
use super::{FrameDirection, encode_attempt_frame};

mod bootstrap;
mod error;
mod model;

pub(in crate::frame) use bootstrap::encode_bootstrap_hello;
pub use error::OutboundFrameError;
pub use model::CommittedResponse;
use model::{OutboundReservation, PendingOutbound};

static NEXT_SENDER_ID: AtomicU64 = AtomicU64::new(1);

struct HeaderCoordinates {
    stream_seq: u64,
    message_id: String,
    reply_to_message_id: Option<String>,
    sent_at_unix_ms: i64,
    deadline_at_unix_ms: Option<i64>,
}

#[derive(Debug)]
pub(in crate::frame) struct OutboundHeaderAuthority {
    sender_id: u64,
    protocol: ProtocolVersion,
    connection: ConnectionId,
    identity: AttemptIdentity,
    channel: wire::TransportChannel,
    direction: FrameDirection,
    maximum_frame_bytes: usize,
    committed_stream_seq: u64,
    next_token: u64,
    pending: Option<OutboundReservation>,
    poisoned: bool,
}

impl OutboundHeaderAuthority {
    pub(in crate::frame) fn new(
        protocol: ProtocolVersion,
        connection: ConnectionId,
        identity: AttemptIdentity,
        channel: wire::TransportChannel,
        direction: FrameDirection,
        maximum_frame_bytes: usize,
        committed_stream_seq: u64,
    ) -> Result<Self, OutboundFrameError> {
        let sender_id = NEXT_SENDER_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| OutboundFrameError::SenderIdExhausted)?;
        Ok(Self {
            sender_id,
            protocol,
            connection,
            identity,
            channel,
            direction,
            maximum_frame_bytes,
            committed_stream_seq,
            next_token: 0,
            pending: None,
            poisoned: false,
        })
    }

    pub(in crate::frame) fn prepare<F>(
        &mut self,
        payload: &wire::FramePayload,
        reply_to_message_id: String,
        deadline_at_unix_ms: i64,
        clock: F,
    ) -> Result<PendingOutbound, OutboundFrameError>
    where
        F: FnOnce() -> i64,
    {
        self.prepare_with_reply(
            payload,
            Some(reply_to_message_id),
            deadline_at_unix_ms,
            clock,
        )
    }

    pub(in crate::frame) fn prepare_new<F>(
        &mut self,
        payload: &wire::FramePayload,
        deadline_at_unix_ms: i64,
        clock: F,
    ) -> Result<PendingOutbound, OutboundFrameError>
    where
        F: FnOnce() -> i64,
    {
        self.prepare_with_reply(payload, None, deadline_at_unix_ms, clock)
    }

    fn prepare_with_reply<F>(
        &mut self,
        payload: &wire::FramePayload,
        reply_to_message_id: Option<String>,
        deadline_at_unix_ms: i64,
        clock: F,
    ) -> Result<PendingOutbound, OutboundFrameError>
    where
        F: FnOnce() -> i64,
    {
        if self.poisoned {
            return Err(OutboundFrameError::SenderPoisoned);
        }
        if self.pending.is_some() {
            return Err(OutboundFrameError::PendingOutboundActive);
        }
        let body = payload.body.as_ref().ok_or(OutboundFrameError::Frame(
            super::FrameValidationError::MissingPayloadBody,
        ))?;
        validate_payload_direction(self.direction, self.channel, body)
            .map_err(OutboundFrameError::Direction)?;
        let stream_seq = self
            .committed_stream_seq
            .checked_add(1)
            .ok_or(OutboundFrameError::SequenceExhausted)?;
        let token = self
            .next_token
            .checked_add(1)
            .ok_or(OutboundFrameError::PendingTokenExhausted)?;
        let sent_at_unix_ms = clock();
        let header = frame_header(
            self.protocol,
            &self.connection,
            &self.identity,
            HeaderCoordinates {
                stream_seq,
                message_id: format!("outbound:{}:{stream_seq}", self.sender_id),
                reply_to_message_id,
                sent_at_unix_ms,
                deadline_at_unix_ms: Some(deadline_at_unix_ms),
            },
        );
        let encoded = encode_attempt_frame(header, self.channel, payload, self.maximum_frame_bytes)
            .map_err(OutboundFrameError::Frame)?;
        let encoded: Arc<[u8]> = encoded.into();
        self.next_token = token;
        self.pending = Some(OutboundReservation {
            token,
            stream_seq,
            allocation: encoded.as_ptr() as usize,
        });
        Ok(PendingOutbound {
            sender_id: self.sender_id,
            token,
            stream_seq,
            encoded,
        })
    }

    pub(in crate::frame) fn validate(
        &self,
        pending: &PendingOutbound,
    ) -> Result<(), OutboundFrameError> {
        let active = self
            .pending
            .as_ref()
            .ok_or(OutboundFrameError::InvalidPendingOutbound)?;
        if pending.sender_id != self.sender_id
            || pending.token != active.token
            || pending.stream_seq != active.stream_seq
            || pending.encoded.as_ptr() as usize != active.allocation
        {
            return Err(OutboundFrameError::InvalidPendingOutbound);
        }
        Ok(())
    }

    pub(in crate::frame) fn commit(&mut self, pending: PendingOutbound) {
        self.committed_stream_seq = pending.into_stream_seq();
        self.pending = None;
    }

    pub(in crate::frame) const fn poison(&mut self) {
        self.poisoned = true;
    }

    pub(in crate::frame) const fn is_poisoned(&self) -> bool {
        self.poisoned
    }
}

fn frame_header(
    protocol: ProtocolVersion,
    connection: &ConnectionId,
    identity: &AttemptIdentity,
    coordinates: HeaderCoordinates,
) -> wire::FrameHeader {
    let identity = identity_to_wire(identity);
    wire::FrameHeader {
        protocol_version: protocol.to_wire(),
        connection_id: connection.as_str().to_owned(),
        message_id: coordinates.message_id,
        reply_to_message_id: coordinates.reply_to_message_id,
        session_id: identity.session_id,
        command_id: identity.command_id,
        agent_run_id: identity.agent_run_id,
        attempt_id: identity.attempt_id,
        executor_owner_id: identity.executor_owner_id,
        fencing_epoch: identity.fencing_epoch,
        correlation_id: identity.correlation_id,
        stream_seq: coordinates.stream_seq,
        sent_at_unix_ms: coordinates.sent_at_unix_ms,
        deadline_at_unix_ms: coordinates.deadline_at_unix_ms,
        root_agent_run_id: identity.root_agent_run_id,
        owner_agent_run_id: identity.owner_agent_run_id,
        parent_agent_run_id: identity.parent_agent_run_id,
        ..wire::FrameHeader::default()
    }
}
