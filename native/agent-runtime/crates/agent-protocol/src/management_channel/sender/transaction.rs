use std::sync::Arc;

use prost::Message;
use zeroize::Zeroize;

use crate::generated::v1 as wire;
use crate::management_frame::{encode_management_frame, management_payload_sha256};

use super::outstanding::OutstandingRecord;
use super::{
    ManagementOutboundAuthority, OutboundReservation, PendingManagementOutbound, build_header,
};
use crate::management_channel::correlation::{LaunchCorrelation, QueryCorrelation};
use crate::management_channel::direction::{
    forbidden_payload, new_payload_allowed, payload_allowed,
};
use crate::management_channel::payload::ManagementPayloadKind;
use crate::management_channel::{ManagementChannelError, ManagementDeadlinePolicy};

impl ManagementOutboundAuthority {
    pub(in crate::management_channel) fn prepare(
        &mut self,
        payload: &wire::ManagementPayload,
        reply_to: Option<String>,
        deadline_policy: ManagementDeadlinePolicy,
        sent_at: i64,
    ) -> Result<PendingManagementOutbound, ManagementChannelError> {
        if self.poisoned {
            return Err(ManagementChannelError::ChannelPoisoned);
        }
        if self.pending.is_some() {
            return Err(ManagementChannelError::PendingOutboundActive);
        }
        let body = payload
            .body
            .as_ref()
            .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)?;
        if !payload_allowed(self.direction, body) {
            return Err(forbidden_payload(self.direction, body));
        }
        if reply_to.is_none() && !new_payload_allowed(self.direction, body) {
            return Err(forbidden_payload(self.direction, body));
        }
        let stream_seq = self
            .committed_stream_seq
            .checked_add(1)
            .ok_or(ManagementChannelError::SequenceExhausted)?;
        let token = self
            .next_token
            .checked_add(1)
            .ok_or(ManagementChannelError::PendingOutboundTokenExhausted)?;
        let deadline_at_unix_ms =
            deadline_policy.deadline_at(sent_at, self.maximum_deadline_timeout_ms)?;
        let message_id = format!(
            "management:{}:{}:{stream_seq}",
            self.direction.label(),
            self.sender_id
        );
        let header = build_header(
            self.protocol,
            &self.connection,
            message_id.clone(),
            reply_to,
            stream_seq,
            sent_at,
            Some(deadline_at_unix_ms),
        )?;
        let mut encoded = encode_management_frame(header, payload)?;
        if encoded.len() > self.maximum_frame_bytes {
            encoded.as_mut_slice().zeroize();
            return Err(ManagementChannelError::FrameTooLarge {
                length: encoded.len(),
                maximum: self.maximum_frame_bytes,
            });
        }
        let kind = ManagementPayloadKind::from_body(body);
        let contains_protected_material =
            crate::management_secrets::contains_protected_material(body);
        let mut payload_bytes = payload.encode_to_vec();
        let payload_digest = management_payload_sha256(&payload_bytes);
        payload_bytes.as_mut_slice().zeroize();
        let outstanding = match self.outstanding_record(
            body,
            kind,
            payload_digest,
            sent_at,
            deadline_at_unix_ms,
            encoded.len(),
        ) {
            Ok(record) => record,
            Err(error) => {
                encoded.as_mut_slice().zeroize();
                return Err(error);
            }
        };
        let encoded: Arc<[u8]> = encoded.into();
        self.next_token = token;
        self.pending = Some(OutboundReservation {
            token,
            stream_seq,
            allocation: encoded.as_ptr() as usize,
        });
        Ok(PendingManagementOutbound {
            sender_id: self.sender_id,
            token,
            stream_seq,
            message_id,
            payload_digest,
            deadline_at_unix_ms,
            encoded,
            outstanding,
            contains_protected_material,
        })
    }

    fn outstanding_record(
        &self,
        body: &wire::management_payload::Body,
        kind: ManagementPayloadKind,
        payload_digest: [u8; 32],
        sent_at: i64,
        deadline_at: i64,
        encoded_bytes: usize,
    ) -> Result<Option<OutstandingRecord>, ManagementChannelError> {
        if kind == ManagementPayloadKind::ManagementAck {
            return Ok(None);
        }
        let launch = match body {
            wire::management_payload::Body::LaunchAttemptProcess(value) => {
                LaunchCorrelation::from_launch(value)
            }
            _ => None,
        };
        let query = match body {
            wire::management_payload::Body::QuerySupervisorState(value) => {
                Some(QueryCorrelation::from_query(value))
            }
            _ => None,
        };
        let record = OutstandingRecord::new(
            kind,
            payload_digest,
            launch,
            query,
            sent_at,
            deadline_at,
            encoded_bytes,
        );
        self.outstanding.validate_capacity(&record)?;
        Ok(Some(record))
    }

    pub(in crate::management_channel) fn validate(
        &self,
        pending: &PendingManagementOutbound,
    ) -> Result<(), ManagementChannelError> {
        let active = self
            .pending
            .as_ref()
            .ok_or(ManagementChannelError::InvalidPendingOutbound)?;
        if pending.sender_id != self.sender_id
            || pending.token != active.token
            || pending.stream_seq != active.stream_seq
            || pending.encoded.as_ptr() as usize != active.allocation
        {
            return Err(ManagementChannelError::InvalidPendingOutbound);
        }
        Ok(())
    }

    pub(in crate::management_channel) fn commit(&mut self, mut pending: PendingManagementOutbound) {
        self.committed_stream_seq = pending.stream_seq;
        if let Some(record) = pending.outstanding.take() {
            self.outstanding
                .insert(std::mem::take(&mut pending.message_id), record);
        }
        self.pending = None;
    }
}
