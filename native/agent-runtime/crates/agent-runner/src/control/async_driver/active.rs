use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use agent_protocol::frame::{
    ActiveFrameReceiveOutcome, AsyncEstablishedAttemptChannel, FrameReceiveOutcome,
};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::operation::AsyncControlOperation;
use super::{AsyncControlDriverError, AsyncRunnerControlDriver};
use crate::control::driver::ControlDriverEvent;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncRunnerControlDriver<S> {
    /// Waits for post-activation traffic without applying read timeout to idle.
    ///
    /// Construction takes the channel synchronously. Dropping the returned
    /// future before its first poll therefore revokes authority and closes it.
    pub(crate) fn receive_active(
        &mut self,
        idle_wake_deadline: Instant,
        hard_deadline: Instant,
    ) -> impl Future<Output = Result<Option<ControlDriverEvent>, AsyncControlDriverError>> + '_ {
        let operation = if self.pending_prepare.is_some() {
            Err(AsyncControlDriverError::PrepareInFlight)
        } else {
            AsyncControlOperation::new(self)
        };
        async move {
            let mut operation = operation?;
            let result = {
                let (driver, channel) = operation.parts();
                driver
                    .receive_active_inner(channel, idle_wake_deadline, hard_deadline)
                    .await
            };
            if result.is_ok() {
                operation.commit();
            }
            result
        }
    }

    async fn receive_active_inner(
        &mut self,
        channel: &mut AsyncEstablishedAttemptChannel<S>,
        idle_wake_deadline: Instant,
        hard_deadline: Instant,
    ) -> Result<Option<ControlDriverEvent>, AsyncControlDriverError> {
        let progress_timeout = match self.session.read_timeout_ms() {
            Ok(value) => Duration::from_millis(value),
            Err(error) => return self.close_with(error.into()),
        };
        let replay_write_timeout = match self.session.write_timeout_ms() {
            Ok(value) => Duration::from_millis(value),
            Err(error) => return self.close_with(error.into()),
        };
        let mut observed_at_unix_ms = None;
        let clock = Arc::clone(&self.clock);
        let received = channel
            .begin_receive_active(
                idle_wake_deadline,
                hard_deadline,
                progress_timeout,
                replay_write_timeout,
                || {
                    let observed = clock.now_unix_ms();
                    observed_at_unix_ms = Some(observed);
                    observed
                },
            )
            .await;
        let received = match received {
            Ok(value) => value,
            Err(error) => return self.close_with(error.into()),
        };
        match received {
            ActiveFrameReceiveOutcome::Idle => Ok(None),
            ActiveFrameReceiveOutcome::Frame(FrameReceiveOutcome::Replay(replay)) => {
                Ok(Some(ControlDriverEvent::Replayed(replay)))
            }
            ActiveFrameReceiveOutcome::Frame(FrameReceiveOutcome::Pending(pending)) => {
                match observed_at_unix_ms {
                Some(observed) => self
                    .handle_pending(channel, *pending, observed)
                    .await
                    .map(Some),
                None => self.close_with(AsyncControlDriverError::ReceiveTimestampMissing),
                }
            }
        }
    }
}
