use std::fmt::{self, Debug, Formatter};

use tokio::io::{AsyncRead, AsyncWrite};

use crate::frame::AsyncEstablishedAttemptChannel;

use super::DataChannelLimits;

/// Authenticated data stream. Construction is possible only through a
/// successful [`super::AsyncPendingDataAttemptChannel::bind`].
pub struct AsyncBoundDataAttemptChannel<S> {
    pub(super) channel: AsyncEstablishedAttemptChannel<S>,
    pub(super) limits: DataChannelLimits,
}

impl<S> Debug for AsyncBoundDataAttemptChannel<S> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AsyncBoundDataAttemptChannel")
            .field("channel", &self.channel)
            .field("limits", &self.limits)
            .finish()
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncBoundDataAttemptChannel<S> {
    #[must_use]
    pub const fn limits(&self) -> &DataChannelLimits {
        &self.limits
    }

    /// Transfers the authenticated stream to the domain-specific hydration
    /// pump. No equivalent escape hatch exists on the unbound typestate.
    #[must_use]
    pub fn into_established(self) -> AsyncEstablishedAttemptChannel<S> {
        self.channel
    }
}
