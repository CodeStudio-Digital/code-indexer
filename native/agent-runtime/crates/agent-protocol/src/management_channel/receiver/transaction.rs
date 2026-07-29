use std::sync::Arc;

use super::ManagementReceiver;
use super::history::CommittedMessage;
use super::model::{
    CommittedManagementInbound, ManagementInboundBinding, PendingManagementInbound,
    ReplayDisposition,
};
use crate::management_channel::ManagementChannelError;

impl ManagementReceiver {
    pub(in crate::management_channel) fn commit(
        &mut self,
        pending: PendingManagementInbound,
        response: Option<Arc<[u8]>>,
    ) -> Result<CommittedManagementInbound, ManagementChannelError> {
        if self.poisoned {
            return Err(ManagementChannelError::ChannelPoisoned);
        }
        let result = self.commit_unpoisoned(pending, response);
        if result.is_err() {
            self.poison();
        }
        result
    }

    fn commit_unpoisoned(
        &mut self,
        pending: PendingManagementInbound,
        response: Option<Arc<[u8]>>,
    ) -> Result<CommittedManagementInbound, ManagementChannelError> {
        self.validate_pending(&pending)?;
        if let Some(bytes) = &response
            && (bytes.is_empty() || bytes.len() > self.context.maximum_frame_bytes)
        {
            return Err(ManagementChannelError::InvalidReplayResponse {
                length: bytes.len(),
                maximum: self.context.maximum_frame_bytes,
            });
        }
        let binding = pending.binding();
        drop(pending);
        let reservation = self
            .pending
            .take()
            .ok_or(ManagementChannelError::InvalidPendingInbound)?;
        let disposition = response.map_or(ReplayDisposition::Accepted, ReplayDisposition::Response);
        self.history.commit(
            reservation.message_id,
            CommittedMessage {
                envelope_digest: reservation.envelope_digest,
                stream_seq: reservation.stream_seq,
                disposition,
            },
        )?;
        self.last_stream_seq = reservation.stream_seq;
        Ok(CommittedManagementInbound::new(binding))
    }

    pub(in crate::management_channel) fn reject(
        &mut self,
        pending: PendingManagementInbound,
    ) -> Result<(), ManagementChannelError> {
        let result = self.validate_pending(&pending);
        drop(pending);
        self.poison();
        result
    }

    fn validate_pending(
        &self,
        pending: &PendingManagementInbound,
    ) -> Result<(), ManagementChannelError> {
        let active = self
            .pending
            .as_ref()
            .ok_or(ManagementChannelError::InvalidPendingInbound)?;
        let binding: ManagementInboundBinding = pending.binding();
        if binding.receiver_id != self.receiver_id
            || binding.token != active.token
            || binding.message_id != active.message_id
            || binding.stream_seq != active.stream_seq
            || binding.envelope_digest != active.envelope_digest
        {
            return Err(ManagementChannelError::InvalidPendingInbound);
        }
        Ok(())
    }

    pub(in crate::management_channel) const fn maximum_frame_bytes(&self) -> usize {
        self.context.maximum_frame_bytes
    }
}
