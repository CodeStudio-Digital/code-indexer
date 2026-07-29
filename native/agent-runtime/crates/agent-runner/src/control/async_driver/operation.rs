use agent_protocol::frame::AsyncEstablishedAttemptChannel;

use super::{AsyncControlDriverError, AsyncRunnerControlDriver};

pub(super) struct AsyncControlOperation<'a, S> {
    driver: &'a mut AsyncRunnerControlDriver<S>,
    channel: Option<AsyncEstablishedAttemptChannel<S>>,
    armed: bool,
}

impl<'a, S> AsyncControlOperation<'a, S> {
    pub(super) fn new(
        driver: &'a mut AsyncRunnerControlDriver<S>,
    ) -> Result<Self, AsyncControlDriverError> {
        let channel = driver
            .channel
            .take()
            .ok_or(AsyncControlDriverError::Closed)?;
        Ok(Self {
            driver,
            channel: Some(channel),
            armed: true,
        })
    }

    pub(super) const fn parts(
        &mut self,
    ) -> (
        &mut AsyncRunnerControlDriver<S>,
        &mut AsyncEstablishedAttemptChannel<S>,
    ) {
        (
            self.driver,
            self.channel
                .as_mut()
                .expect("armed async operation owns its channel"),
        )
    }

    pub(super) fn commit(mut self) {
        self.driver.channel = self.channel.take();
        self.armed = false;
    }
}

impl<S> Drop for AsyncControlOperation<'_, S> {
    fn drop(&mut self) {
        if self.armed {
            self.driver.session.connection_lost();
            self.driver.pending_prepare = None;
            self.driver.channel = None;
            self.channel = None;
        }
    }
}
