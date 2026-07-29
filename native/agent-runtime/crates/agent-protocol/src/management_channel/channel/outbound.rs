use std::io::{Read, Write};
use std::sync::Arc;

use crate::generated::v1 as wire;

use super::{EstablishedManagementChannel, ManagementChannelResponse, SentManagementFrame};
use crate::management_channel::channel::validation::{
    validate_management_body, validate_response_correlation,
};
use crate::management_channel::{
    ManagementChannelError, ManagementDeadlinePolicy, PendingManagementInbound,
};

impl<R: Read, W: Write> EstablishedManagementChannel<R, W> {
    /// Commits a correlated acknowledgement whose identity, digest and
    /// timestamp are derived from the pending inbound and channel clock.
    ///
    /// # Errors
    ///
    /// Invalid correlation, bounds, time, or writes poison the channel.
    pub fn commit_acknowledged(
        &mut self,
        inbound: PendingManagementInbound,
        deadline_policy: ManagementDeadlinePolicy,
    ) -> Result<ManagementChannelResponse, ManagementChannelError> {
        let acknowledged_at_unix_ms = self.clock.now_unix_ms();
        let payload = wire::ManagementPayload {
            body: Some(wire::management_payload::Body::ManagementAck(
                wire::ManagementAck {
                    acknowledged_message_id: inbound.message_id().to_owned(),
                    acknowledged_payload_sha256: inbound.payload_digest().to_vec(),
                    acknowledged_at_unix_ms,
                },
            )),
        };
        self.commit_response_at(inbound, &payload, deadline_policy, acknowledged_at_unix_ms)
    }

    /// Commits one semantic response under the private outbound authority.
    ///
    /// # Errors
    ///
    /// Invalid correlation, bounds, time, or writes poison the channel.
    pub fn commit_response(
        &mut self,
        inbound: PendingManagementInbound,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
    ) -> Result<ManagementChannelResponse, ManagementChannelError> {
        let sent_at = self.clock.now_unix_ms();
        self.commit_response_at(inbound, payload, deadline_policy, sent_at)
    }

    #[cfg(test)]
    pub(in crate::management_channel) fn commit_response_with_clock<F>(
        &mut self,
        inbound: PendingManagementInbound,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
        clock: F,
    ) -> Result<ManagementChannelResponse, ManagementChannelError>
    where
        F: FnOnce() -> i64,
    {
        self.commit_response_at(inbound, payload, deadline_policy, clock())
    }

    fn commit_response_at(
        &mut self,
        inbound: PendingManagementInbound,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
        sent_at: i64,
    ) -> Result<ManagementChannelResponse, ManagementChannelError> {
        let body = payload
            .body
            .as_ref()
            .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)
            .inspect_err(|_| self.poison_all())?;
        validate_management_body(&self.policy, self.sender.connection(), body, sent_at)
            .inspect_err(|_| self.poison_all())?;
        validate_response_correlation(self.sender.connection(), &inbound, payload, sent_at)
            .inspect_err(|_| self.poison_all())?;
        let reply_to = inbound.message_id().to_owned();
        let inbound_reply_to = inbound.reply_to_message_id().map(str::to_owned);
        let outbound = self
            .sender
            .prepare(payload, Some(reply_to), deadline_policy, sent_at)
            .inspect_err(|_| self.poison_all())?;
        self.sender
            .validate(&outbound)
            .inspect_err(|_| self.poison_all())?;
        let encoded = outbound.shared();
        let receipt = self
            .receiver
            .commit(inbound, Some(Arc::clone(&encoded)))
            .inspect_err(|_| {
                self.transport.poison();
                self.sender.poison();
            })?;
        self.sender
            .complete_inbound_response(inbound_reply_to.as_deref());
        if let Err(error) = self.transport.write_raw(&encoded) {
            self.receiver.poison();
            self.sender.poison();
            return Err(ManagementChannelError::Framing(error));
        }
        let sent = SentManagementFrame {
            stream_seq: outbound.stream_seq(),
            message_id: outbound.message_id().to_owned(),
            payload_digest: *outbound.payload_digest(),
        };
        self.sender.commit(outbound);
        Ok(ManagementChannelResponse { receipt, sent })
    }

    /// Writes a new request or asynchronous fact without a reply binding.
    ///
    /// # Errors
    ///
    /// Invalid disposition, bounds, time, or writes poison the channel.
    pub fn send_new(
        &mut self,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
    ) -> Result<SentManagementFrame, ManagementChannelError> {
        let sent_at = self.clock.now_unix_ms();
        self.send_new_at(payload, deadline_policy, sent_at)
    }

    #[cfg(test)]
    pub(in crate::management_channel) fn send_new_with_clock<F>(
        &mut self,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
        clock: F,
    ) -> Result<SentManagementFrame, ManagementChannelError>
    where
        F: FnOnce() -> i64,
    {
        self.send_new_at(payload, deadline_policy, clock())
    }

    fn send_new_at(
        &mut self,
        payload: &wire::ManagementPayload,
        deadline_policy: ManagementDeadlinePolicy,
        sent_at: i64,
    ) -> Result<SentManagementFrame, ManagementChannelError> {
        let body = payload
            .body
            .as_ref()
            .ok_or(crate::management_frame::ManagementFrameError::MissingPayloadBody)
            .inspect_err(|_| self.poison_all())?;
        validate_management_body(&self.policy, self.sender.connection(), body, sent_at)
            .inspect_err(|_| self.poison_all())?;
        let outbound = self
            .sender
            .prepare(payload, None, deadline_policy, sent_at)
            .inspect_err(|_| self.poison_all())?;
        self.sender
            .validate(&outbound)
            .inspect_err(|_| self.poison_all())?;
        let sent = SentManagementFrame {
            stream_seq: outbound.stream_seq(),
            message_id: outbound.message_id().to_owned(),
            payload_digest: *outbound.payload_digest(),
        };
        if let Err(error) = self.transport.write_raw(outbound.encoded()) {
            self.receiver.poison();
            self.sender.poison();
            return Err(ManagementChannelError::Framing(error));
        }
        self.sender.commit(outbound);
        Ok(sent)
    }
}
