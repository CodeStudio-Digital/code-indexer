use std::fmt::{self, Debug, Formatter};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use zeroize::Zeroize;

use crate::generated::v1 as wire;
use crate::identity::ConnectionId;
use crate::management_frame::encode_management_frame;
use crate::version::ProtocolVersion;

use super::direction::new_payload_allowed;
use super::header::validate_management_header;
use super::payload::ManagementPayloadKind;
use super::{ManagementChannelError, ManagementDirection};

mod outstanding;
mod transaction;

use outstanding::{OutstandingRecord, OutstandingRegistry};

static NEXT_SENDER_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug)]
struct OutboundReservation {
    token: u64,
    stream_seq: u64,
    allocation: usize,
}

pub(super) struct PendingManagementOutbound {
    sender_id: u64,
    token: u64,
    stream_seq: u64,
    message_id: String,
    payload_digest: [u8; 32],
    deadline_at_unix_ms: i64,
    encoded: Arc<[u8]>,
    outstanding: Option<OutstandingRecord>,
    contains_protected_material: bool,
}

impl Debug for PendingManagementOutbound {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingManagementOutbound")
            .field("sender_id", &self.sender_id)
            .field("token", &self.token)
            .field("stream_seq", &self.stream_seq)
            .field("message_id", &self.message_id)
            .field("encoded_length", &self.encoded.len())
            .field("encoded", &"[REDACTED]")
            .finish_non_exhaustive()
    }
}

impl PendingManagementOutbound {
    pub(super) fn shared(&self) -> Arc<[u8]> {
        Arc::clone(&self.encoded)
    }

    pub(super) fn encoded(&self) -> &[u8] {
        &self.encoded
    }

    pub(super) const fn stream_seq(&self) -> u64 {
        self.stream_seq
    }

    pub(super) fn message_id(&self) -> &str {
        &self.message_id
    }

    pub(super) const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }

    pub(super) const fn deadline_at_unix_ms(&self) -> i64 {
        self.deadline_at_unix_ms
    }
}

impl Drop for PendingManagementOutbound {
    fn drop(&mut self) {
        if self.contains_protected_material {
            let encoded = Arc::get_mut(&mut self.encoded)
                .expect("protected outbound bytes cannot escape their transaction");
            encoded.zeroize();
        }
    }
}

#[derive(Debug)]
pub(super) struct ManagementOutboundAuthority {
    sender_id: u64,
    protocol: ProtocolVersion,
    connection: ConnectionId,
    direction: ManagementDirection,
    maximum_frame_bytes: usize,
    maximum_deadline_timeout_ms: u64,
    committed_stream_seq: u64,
    next_token: u64,
    pending: Option<OutboundReservation>,
    outstanding: OutstandingRegistry,
    poisoned: bool,
}

impl ManagementOutboundAuthority {
    pub(super) fn new(
        protocol: ProtocolVersion,
        connection: ConnectionId,
        direction: ManagementDirection,
        maximum_frame_bytes: usize,
        maximum_deadline_timeout_ms: u64,
        maximum_outstanding_frames: u64,
        maximum_outstanding_bytes: u64,
    ) -> Result<Self, ManagementChannelError> {
        let sender_id = next_sender_id()?;
        let outstanding =
            OutstandingRegistry::new(maximum_outstanding_frames, maximum_outstanding_bytes)?;
        Ok(Self {
            sender_id,
            protocol,
            connection,
            direction,
            maximum_frame_bytes,
            maximum_deadline_timeout_ms,
            committed_stream_seq: 1,
            next_token: 0,
            pending: None,
            outstanding,
            poisoned: false,
        })
    }

    pub(super) fn poison(&mut self) {
        self.poisoned = true;
        self.pending = None;
        self.outstanding.clear();
    }

    pub(super) const fn is_poisoned(&self) -> bool {
        self.poisoned
    }

    pub(super) const fn connection(&self) -> &ConnectionId {
        &self.connection
    }

    pub(super) fn validate_inbound_response(
        &self,
        reply_to: Option<&str>,
        body: &wire::management_payload::Body,
        observed_at: i64,
    ) -> Result<(), ManagementChannelError> {
        match reply_to {
            Some(reply_to) => {
                if new_payload_allowed(self.direction.reverse(), body) {
                    return Err(ManagementChannelError::UnexpectedReplyTo {
                        payload: ManagementPayloadKind::from_body(body).name(),
                    });
                }
                self.outstanding
                    .validate_response(reply_to, body, &self.connection, observed_at)
            }
            None if new_payload_allowed(self.direction.reverse(), body) => Ok(()),
            None => Err(ManagementChannelError::MissingReplyTo {
                payload: ManagementPayloadKind::from_body(body).name(),
            }),
        }
    }

    pub(super) fn complete_inbound_response(&mut self, reply_to: Option<&str>) {
        self.outstanding.complete(reply_to);
    }

    pub(super) fn has_outstanding_capacity(&self) -> bool {
        self.outstanding.has_capacity_for(self.maximum_frame_bytes)
    }

    pub(super) fn earliest_outstanding_deadline_at(&self) -> Option<i64> {
        self.outstanding.earliest_deadline_at()
    }

    #[cfg(test)]
    pub(super) const fn has_pending(&self) -> bool {
        self.pending.is_some()
    }

    #[cfg(test)]
    pub(super) fn retained_outstanding(&self) -> (usize, usize) {
        self.outstanding.retained_state()
    }
}

pub(super) fn encode_bootstrap(
    protocol: ProtocolVersion,
    connection: &ConnectionId,
    direction: ManagementDirection,
    channel_id: u64,
    payload: &wire::ManagementPayload,
    sent_at: i64,
) -> Result<Vec<u8>, ManagementChannelError> {
    let header = build_header(
        protocol,
        connection,
        format!("management-bootstrap:{}:{channel_id}:1", direction.label()),
        None,
        1,
        sent_at,
        None,
    )?;
    encode_management_frame(header, payload).map_err(Into::into)
}

fn build_header(
    protocol: ProtocolVersion,
    connection: &ConnectionId,
    message_id: String,
    reply_to_message_id: Option<String>,
    stream_seq: u64,
    sent_at_unix_ms: i64,
    deadline_at_unix_ms: Option<i64>,
) -> Result<wire::ManagementFrameHeader, ManagementChannelError> {
    let header = wire::ManagementFrameHeader {
        protocol_version: protocol.to_wire(),
        connection_id: connection.as_str().to_owned(),
        message_id,
        reply_to_message_id,
        stream_seq,
        sent_at_unix_ms,
        deadline_at_unix_ms,
        payload_sha256: Vec::new(),
    };
    validate_management_header(header.clone())?;
    Ok(header)
}

fn next_sender_id() -> Result<u64, ManagementChannelError> {
    NEXT_SENDER_ID
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| ManagementChannelError::SenderIdExhausted)
}
