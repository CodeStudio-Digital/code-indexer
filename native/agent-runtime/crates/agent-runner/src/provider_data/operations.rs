use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::validation::validate_cancel;
use super::{ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    /// Sends an exact cancellation command for the active operation.
    ///
    /// # Errors
    ///
    /// Returns a typed error when the operation authority is invalid or the
    /// bounded write cannot be committed.
    pub async fn cancel<C: ProviderDataClock>(
        &mut self,
        cancel: wire::ProviderCancel,
        semantic_deadline_at_unix_ms: i64,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<(), ProviderDataError> {
        let active = self
            .active
            .as_ref()
            .ok_or(ProviderDataError::NoActiveOperation)?;
        validate_cancel(&cancel, &self.identity, &active.operation_id)?;
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::ProviderCancel(cancel)),
        };
        self.channel
            .send_new(
                &payload,
                semantic_deadline_at_unix_ms,
                timing.hard_deadline,
                || clock.now_unix_ms(),
            )
            .await?;
        Ok(())
    }
}
