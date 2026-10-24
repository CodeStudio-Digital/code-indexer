use agent_protocol::frame::FrameReceiveOutcome;
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::validation::{validate_accepted, validate_start};
use super::{ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    /// Persists a settled frontier, independently of provider admission.
    ///
    /// # Errors
    /// Rejects active operations and any foreign or uncommitted receipt.
    pub async fn checkpoint<C: ProviderDataClock>(
        &mut self,
        start: wire::ProviderStart,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<(), ProviderDataError> {
        if self.active.is_some() || self.read_batch.is_some() || !self.buffered_events.is_empty() {
            return Err(ProviderDataError::OperationAlreadyActive);
        }
        validate_start(&start, &self.identity)?;
        let operation_id = start.operation_id.clone();
        let request = self
            .send_provider_request(start, true, timing, clock, || {})
            .await?;
        loop {
            let outcome = self
                .channel
                .begin_receive(
                    timing.hard_deadline,
                    timing.hard_deadline,
                    timing.replay_write_timeout,
                    || clock.now_unix_ms(),
                )
                .await?;
            let FrameReceiveOutcome::Pending(mut pending) = outcome else {
                continue;
            };
            let binding = pending.binding();
            let header = pending.header().clone();
            let (body, _) = pending.take_body_and_digest()?;
            let wire::frame_payload::Body::ProviderCheckpointCommitted(receipt) = body else {
                return Err(ProviderDataError::UnexpectedPayload(
                    "expected checkpoint receipt",
                ));
            };
            if receipt.identity.as_ref() != Some(&self.identity) {
                return Err(ProviderDataError::Correlation(
                    "checkpoint identity mismatch",
                ));
            }
            validate_accepted(
                wire::frame_payload::Body::ProviderAccepted(receipt),
                &header,
                &request,
                &operation_id,
                &self.runtime_instance_id,
                clock.now_unix_ms(),
            )?;
            if !self.channel.commit_accepted(*pending)?.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            return Ok(());
        }
    }
}
