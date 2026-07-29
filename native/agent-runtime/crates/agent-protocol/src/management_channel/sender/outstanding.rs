use std::collections::{HashMap, VecDeque};
use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;
use crate::identity::ConnectionId;

use crate::management_channel::ManagementChannelError;
use crate::management_channel::correlation::{LaunchCorrelation, QueryCorrelation};
use crate::management_channel::direction::response_payload_allowed;
use crate::management_channel::payload::ManagementPayloadKind;

pub(super) struct OutstandingRecord {
    kind: ManagementPayloadKind,
    payload_digest: [u8; 32],
    launch: Option<LaunchCorrelation>,
    query: Option<QueryCorrelation>,
    sent_at_unix_ms: i64,
    deadline_at_unix_ms: i64,
    encoded_bytes: usize,
}

impl Debug for OutstandingRecord {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OutstandingRecord")
            .field("kind", &self.kind)
            .field("encoded_bytes", &self.encoded_bytes)
            .finish_non_exhaustive()
    }
}

impl OutstandingRecord {
    pub(super) const fn new(
        kind: ManagementPayloadKind,
        payload_digest: [u8; 32],
        launch: Option<LaunchCorrelation>,
        query: Option<QueryCorrelation>,
        sent_at_unix_ms: i64,
        deadline_at_unix_ms: i64,
        encoded_bytes: usize,
    ) -> Self {
        Self {
            kind,
            payload_digest,
            launch,
            query,
            sent_at_unix_ms,
            deadline_at_unix_ms,
            encoded_bytes,
        }
    }

    const fn bytes(&self) -> usize {
        self.encoded_bytes
    }
}

#[derive(Debug)]
pub(super) struct OutstandingRegistry {
    entries: HashMap<String, OutstandingRecord>,
    order: VecDeque<String>,
    retained_bytes: usize,
    maximum_entries: usize,
    maximum_bytes: usize,
}

impl OutstandingRegistry {
    pub(super) fn new(
        maximum_entries: u64,
        maximum_bytes: u64,
    ) -> Result<Self, ManagementChannelError> {
        let maximum_entries = usize::try_from(maximum_entries)
            .map_err(|_| ManagementChannelError::InvalidFrameLimits)?;
        let maximum_bytes = usize::try_from(maximum_bytes)
            .map_err(|_| ManagementChannelError::InvalidFrameLimits)?;
        if maximum_entries == 0 || maximum_bytes == 0 {
            return Err(ManagementChannelError::InvalidFrameLimits);
        }
        Ok(Self {
            entries: HashMap::with_capacity(maximum_entries),
            order: VecDeque::with_capacity(maximum_entries),
            retained_bytes: 0,
            maximum_entries,
            maximum_bytes,
        })
    }

    pub(super) fn validate_capacity(
        &self,
        record: &OutstandingRecord,
    ) -> Result<(), ManagementChannelError> {
        let frames = self.entries.len().saturating_add(1);
        let bytes = self.retained_bytes.saturating_add(record.bytes());
        if frames > self.maximum_entries || bytes > self.maximum_bytes {
            return Err(ManagementChannelError::OutstandingCapacityExhausted {
                frames,
                maximum_frames: self.maximum_entries,
                bytes,
                maximum_bytes: self.maximum_bytes,
            });
        }
        Ok(())
    }

    pub(super) fn insert(&mut self, message_id: String, record: OutstandingRecord) {
        self.retained_bytes += record.bytes();
        self.order.push_back(message_id.clone());
        let replaced = self.entries.insert(message_id, record);
        debug_assert!(
            replaced.is_none(),
            "sender generated a duplicate message ID"
        );
    }

    pub(super) fn validate_response(
        &self,
        reply_to: &str,
        body: &wire::management_payload::Body,
        connection: &ConnectionId,
        observed_at: i64,
    ) -> Result<(), ManagementChannelError> {
        let record = self
            .entries
            .get(reply_to)
            .ok_or(ManagementChannelError::UnknownReplyTo)?;
        if self.order.front().map(String::as_str) != Some(reply_to) {
            return Err(ManagementChannelError::OutOfOrderResponse);
        }
        if !response_payload_allowed(record.kind, body) {
            return Err(ManagementChannelError::InvalidResponseCorrelation {
                inbound: record.kind.name(),
                outbound: ManagementPayloadKind::from_body(body).name(),
            });
        }
        let response_time = response_timestamp(body).ok_or_else(|| {
            ManagementChannelError::InvalidResponseSemantics {
                payload: ManagementPayloadKind::from_body(body).name(),
                field: "response_timestamp",
            }
        })?;
        if response_time < record.sent_at_unix_ms || response_time > observed_at {
            return Err(ManagementChannelError::InvalidResponseSemantics {
                payload: ManagementPayloadKind::from_body(body).name(),
                field: "response_timestamp",
            });
        }
        match body {
            wire::management_payload::Body::ManagementAck(value) => {
                if value.acknowledged_message_id != reply_to
                    || value.acknowledged_payload_sha256.as_slice() != record.payload_digest
                {
                    return Err(ManagementChannelError::InvalidAcknowledgement);
                }
            }
            wire::management_payload::Body::LaunchAccepted(value) => {
                if !record
                    .launch
                    .as_ref()
                    .is_some_and(|launch| launch.accepts(value))
                {
                    return Err(ManagementChannelError::InvalidResponseSemantics {
                        payload: "LaunchAccepted",
                        field: "identity_budget_or_deadline",
                    });
                }
            }
            wire::management_payload::Body::LaunchRejected(value) => {
                if !record
                    .launch
                    .as_ref()
                    .is_some_and(|launch| launch.rejects(value))
                {
                    return Err(ManagementChannelError::InvalidResponseSemantics {
                        payload: "LaunchRejected",
                        field: "identity",
                    });
                }
            }
            wire::management_payload::Body::SupervisorState(value)
                if value.connection_id != connection.as_str()
                    || !record
                        .query
                        .as_ref()
                        .is_some_and(|query| query.accepts(value)) =>
            {
                return Err(ManagementChannelError::InvalidResponseSemantics {
                    payload: "SupervisorState",
                    field: "query_filter_or_resource_shape",
                });
            }
            _ => {}
        }
        Ok(())
    }

    pub(super) fn complete(&mut self, reply_to: Option<&str>) {
        let Some(reply_to) = reply_to else {
            return;
        };
        if self.order.front().map(String::as_str) != Some(reply_to) {
            return;
        }
        self.order.pop_front();
        if let Some(record) = self.entries.remove(reply_to) {
            self.retained_bytes -= record.bytes();
        }
    }

    pub(super) fn clear(&mut self) {
        self.entries = HashMap::new();
        self.order = VecDeque::new();
        self.retained_bytes = 0;
    }

    pub(super) fn has_capacity_for(&self, maximum_frame_bytes: usize) -> bool {
        self.entries.len() < self.maximum_entries
            && self
                .retained_bytes
                .checked_add(maximum_frame_bytes)
                .is_some_and(|bytes| bytes <= self.maximum_bytes)
    }

    pub(super) fn earliest_deadline_at(&self) -> Option<i64> {
        self.order
            .front()
            .and_then(|message_id| self.entries.get(message_id))
            .map(|record| record.deadline_at_unix_ms)
    }

    #[cfg(test)]
    pub(super) fn retained_state(&self) -> (usize, usize) {
        (self.entries.len(), self.retained_bytes)
    }
}

const fn response_timestamp(body: &wire::management_payload::Body) -> Option<i64> {
    match body {
        wire::management_payload::Body::LaunchAccepted(value) => Some(value.accepted_at_unix_ms),
        wire::management_payload::Body::LaunchRejected(value) => Some(value.rejected_at_unix_ms),
        wire::management_payload::Body::SupervisorState(value) => Some(value.observed_at_unix_ms),
        wire::management_payload::Body::ManagementAck(value) => Some(value.acknowledged_at_unix_ms),
        _ => None,
    }
}
