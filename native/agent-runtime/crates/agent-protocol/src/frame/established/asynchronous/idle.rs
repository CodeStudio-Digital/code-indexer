use std::future::Future;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;
use zeroize::Zeroizing;

use super::operation::AsyncEstablishedOperation;
use super::{AsyncEstablishedAttemptChannel, AsyncEstablishedChannelError};
use crate::frame::{FrameReceiveOutcome, InboundFrameError};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncEstablishedAttemptChannel<S> {
    /// Receives active control traffic without treating idle as failure.
    ///
    /// The first byte may wait until `hard_deadline`; after it arrives,
    /// `progress_timeout` bounds the rest of the frame.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed channel error for an expired deadline, stalled or
    /// malformed frame, EOF, replay write failure, or prior channel poisoning.
    pub fn begin_receive_active<'a, F>(
        &'a mut self,
        hard_deadline: Instant,
        progress_timeout: Duration,
        replay_write_timeout: Duration,
        clock: F,
    ) -> impl Future<Output = Result<FrameReceiveOutcome, AsyncEstablishedChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let mut operation = AsyncEstablishedOperation::new(self);
        async move {
            let result = operation
                .channel()
                .begin_receive_active_inner(
                    hard_deadline,
                    progress_timeout,
                    replay_write_timeout,
                    clock,
                )
                .await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn begin_receive_active_inner<F>(
        &mut self,
        hard_deadline: Instant,
        progress_timeout: Duration,
        replay_write_timeout: Duration,
        clock: F,
    ) -> Result<FrameReceiveOutcome, AsyncEstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        if self.receiver.has_pending() {
            return Err(AsyncEstablishedChannelError::Inbound(
                InboundFrameError::PendingInboundActive,
            ));
        }
        let encoded = match self
            .transport
            .receive_idle_progress_bounded(hard_deadline, progress_timeout)
            .await
        {
            Ok(encoded) => Zeroizing::new(encoded),
            Err(error) => {
                self.receiver.poison();
                self.sender.poison();
                return Err(AsyncEstablishedChannelError::Framing(error));
            }
        };
        let outcome = match self.receiver.begin_receive(encoded.as_slice(), clock) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.transport.poison();
                self.sender.poison();
                return Err(AsyncEstablishedChannelError::Inbound(error));
            }
        };
        if let FrameReceiveOutcome::Replay(replay) = &outcome {
            let replay_deadline = Instant::now()
                .checked_add(replay_write_timeout)
                .map_or(hard_deadline, |deadline| deadline.min(hard_deadline));
            let response = self
                .receiver
                .take_replay_response(replay)
                .map_err(|error| {
                    self.poison_all();
                    AsyncEstablishedChannelError::Inbound(error)
                })?;
            if let Some(response) = response
                && let Err(error) = self.transport.send(&response, replay_deadline).await
            {
                self.receiver.poison();
                self.sender.poison();
                return Err(AsyncEstablishedChannelError::Framing(error));
            }
        }
        Ok(outcome)
    }
}
