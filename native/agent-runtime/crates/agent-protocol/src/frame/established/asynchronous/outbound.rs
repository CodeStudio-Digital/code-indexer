use std::future::Future;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::operation::AsyncEstablishedOperation;
use super::{AsyncEstablishedAttemptChannel, AsyncEstablishedChannelError};
use crate::frame::CommittedOutbound;
use crate::generated::v1 as wire;

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> AsyncEstablishedAttemptChannel<S> {
    /// Sends a fresh unsolicited payload under the channel-owned sequence.
    ///
    /// Header authority commits only after physical write; cancellation
    /// poisons the channel. The frame has no `reply_to_message_id`.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid authority, direction, deadline, or write.
    pub fn send_new<'a, F>(
        &'a mut self,
        payload: &'a wire::FramePayload,
        semantic_deadline_at_unix_ms: i64,
        physical_deadline: Instant,
        clock: F,
    ) -> impl Future<Output = Result<CommittedOutbound, AsyncEstablishedChannelError>> + 'a
    where
        F: FnOnce() -> i64 + 'a,
    {
        let mut operation = AsyncEstablishedOperation::new(self);
        async move {
            let result = operation
                .channel()
                .send_new_inner(
                    payload,
                    semantic_deadline_at_unix_ms,
                    physical_deadline,
                    clock,
                )
                .await;
            if result.is_ok() {
                operation.disarm();
            }
            result
        }
    }

    async fn send_new_inner<F>(
        &mut self,
        payload: &wire::FramePayload,
        semantic_deadline_at_unix_ms: i64,
        physical_deadline: Instant,
        clock: F,
    ) -> Result<CommittedOutbound, AsyncEstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        let outbound = self
            .sender
            .prepare_new(payload, semantic_deadline_at_unix_ms, clock)
            .map_err(|error| {
                self.poison_all();
                AsyncEstablishedChannelError::Outbound(error)
            })?;
        self.sender.validate(&outbound).map_err(|error| {
            self.poison_all();
            AsyncEstablishedChannelError::Outbound(error)
        })?;
        let encoded = outbound.shared();
        if let Err(error) = self.transport.send(&encoded, physical_deadline).await {
            self.receiver.poison();
            self.sender.poison();
            return Err(AsyncEstablishedChannelError::Framing(error));
        }
        Ok(self.sender.commit(outbound))
    }
}
