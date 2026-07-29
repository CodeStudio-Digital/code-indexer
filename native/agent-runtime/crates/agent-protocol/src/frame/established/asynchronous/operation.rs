use tokio::io::{AsyncRead, AsyncWrite};

use super::AsyncEstablishedAttemptChannel;

pub(super) struct AsyncEstablishedOperation<'a, S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    channel: &'a mut AsyncEstablishedAttemptChannel<S>,
    armed: bool,
}

impl<'a, S> AsyncEstablishedOperation<'a, S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    pub(super) const fn new(channel: &'a mut AsyncEstablishedAttemptChannel<S>) -> Self {
        Self {
            channel,
            armed: true,
        }
    }

    pub(super) const fn channel(&mut self) -> &mut AsyncEstablishedAttemptChannel<S> {
        self.channel
    }

    pub(super) const fn disarm(&mut self) {
        self.armed = false;
    }
}

impl<S> Drop for AsyncEstablishedOperation<'_, S>
where
    S: AsyncRead + AsyncWrite + Unpin + 'static,
{
    fn drop(&mut self) {
        if self.armed {
            self.channel.poison_all();
        }
    }
}
