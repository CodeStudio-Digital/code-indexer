use std::io::{Read, Write};

use crate::generated::v1 as wire;

use super::{EstablishedAttemptChannel, EstablishedChannelError};
use crate::frame::{BoundedReplayOutcome, CommittedInbound, CommittedResponse, PendingInbound};

impl<R: Read, W: Write> EstablishedAttemptChannel<R, W> {
    /// Builds, commits, and writes one response under the channel-owned header
    /// authority. `reply_to_message_id` is derived from `inbound`.
    ///
    /// # Errors
    ///
    /// Invalid authority, payload, clock, deadline, budget, or write failure
    /// poison the complete channel before a receipt is returned.
    pub fn commit_response<F>(
        &mut self,
        inbound: PendingInbound,
        payload: &wire::FramePayload,
        deadline_at_unix_ms: i64,
        clock: F,
    ) -> Result<CommittedResponse, EstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        let reply_to = inbound.message_id().to_owned();
        let outbound = match self
            .sender
            .prepare(payload, reply_to, deadline_at_unix_ms, clock)
        {
            Ok(outbound) => outbound,
            Err(error) => {
                self.poison_all();
                return Err(EstablishedChannelError::Outbound(error));
            }
        };
        if let Err(error) = self.sender.validate(&outbound) {
            self.poison_all();
            return Err(EstablishedChannelError::Outbound(error));
        }
        let response = outbound.shared();
        let outcome = BoundedReplayOutcome::from_shared_response(response.clone());
        let receipt = match self.receiver.commit(inbound, outcome) {
            Ok(receipt) => receipt,
            Err(error) => {
                self.transport.poison();
                self.sender.poison();
                return Err(EstablishedChannelError::Inbound(error));
            }
        };
        if let Err(error) = self.transport.write_raw(&response) {
            self.receiver.poison();
            self.sender.poison();
            return Err(EstablishedChannelError::Framing(error));
        }
        self.sender.commit(outbound);
        Ok(CommittedResponse::new(receipt))
    }

    /// Commits an inbound message that has no response bytes.
    ///
    /// # Errors
    ///
    /// Invalid inbound authority poisons both protocol directions.
    pub fn commit_accepted(
        &mut self,
        inbound: PendingInbound,
    ) -> Result<CommittedInbound, EstablishedChannelError> {
        self.receiver
            .commit(inbound, BoundedReplayOutcome::accepted())
            .map_err(|error| {
                self.transport.poison();
                self.sender.poison();
                EstablishedChannelError::Inbound(error)
            })
    }

    pub(super) fn poison_all(&mut self) {
        self.receiver.poison();
        self.sender.poison();
        self.transport.poison();
    }
}
