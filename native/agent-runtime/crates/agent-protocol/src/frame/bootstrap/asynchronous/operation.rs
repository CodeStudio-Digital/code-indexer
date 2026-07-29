use tokio::io::{AsyncRead, AsyncWrite};

use super::AsyncBootstrapAttemptChannel;

pub(super) struct AsyncBootstrapOperation<'a, S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    channel: &'a mut AsyncBootstrapAttemptChannel<S>,
    armed: bool,
}

impl<'a, S> AsyncBootstrapOperation<'a, S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    pub(super) const fn new(channel: &'a mut AsyncBootstrapAttemptChannel<S>) -> Self {
        Self {
            channel,
            armed: true,
        }
    }

    pub(super) const fn channel(&mut self) -> &mut AsyncBootstrapAttemptChannel<S> {
        self.channel
    }

    pub(super) const fn disarm(&mut self) {
        self.armed = false;
    }
}

impl<S> Drop for AsyncBootstrapOperation<'_, S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    fn drop(&mut self) {
        if self.armed {
            self.channel.poison();
        }
    }
}
