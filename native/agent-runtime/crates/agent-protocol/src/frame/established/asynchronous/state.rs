use tokio::io::{AsyncRead, AsyncWrite};

use super::{AsyncEstablishedAttemptChannel, AsyncEstablishedChannelError};
use crate::frame::{BoundedReplayOutcome, CommittedInbound, PendingInbound};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncEstablishedAttemptChannel<S> {
    /// Commits inbound work that has no response bytes.
    ///
    /// # Errors
    ///
    /// A foreign or stale token poisons the complete channel.
    pub fn commit_accepted(
        &mut self,
        pending: PendingInbound,
    ) -> Result<CommittedInbound, AsyncEstablishedChannelError> {
        self.receiver
            .commit(pending, BoundedReplayOutcome::accepted())
            .map_err(|error| {
                self.poison_all();
                AsyncEstablishedChannelError::Inbound(error)
            })
    }

    /// Rejects pending work and permanently poisons the complete channel.
    ///
    /// # Errors
    ///
    /// Returns an inbound error when the pending token is foreign or stale.
    pub fn reject(&mut self, pending: PendingInbound) -> Result<(), AsyncEstablishedChannelError> {
        let result = self.receiver.reject(pending);
        self.poison_all();
        result.map_err(AsyncEstablishedChannelError::Inbound)
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.transport.is_poisoned() || self.receiver.is_poisoned() || self.sender.is_poisoned()
    }

    pub(super) fn poison_all(&mut self) {
        self.receiver.poison();
        self.sender.poison();
        self.transport.poison();
    }
}
