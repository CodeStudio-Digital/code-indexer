use agent_protocol::frame::FrameReceiveOutcome;
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::validation::{
    validate_engine_committed, validate_engine_proposal, validate_stream_event,
};
use super::{
    ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming, ProviderWireEvent,
};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    /// Commits one canonical engine record through the Host-side native store.
    /// Provider events that race ahead of the receipt are authenticated and
    /// buffered, so the single Data stream keeps exactly one physical owner.
    ///
    /// # Errors
    ///
    /// Returns a typed error when proposal authority, transport correlation,
    /// the Host commit receipt, or the single Data owner diverges.
    pub async fn commit_engine_event<C: ProviderDataClock>(
        &mut self,
        proposal: wire::EngineEventProposal,
        semantic_deadline_at_unix_ms: i64,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::CommitSessionRecordReceipt, ProviderDataError> {
        validate_engine_proposal(&proposal, &self.identity, &self.runtime_instance_id)?;
        let local_sequence = proposal
            .record
            .as_ref()
            .ok_or(ProviderDataError::InvalidRequest(
                "engine record is missing",
            ))?
            .local_sequence;
        let payload_digest = proposal.expected_payload_sha256.clone();
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::EngineEventProposal(proposal)),
        };
        let request = self
            .channel
            .send_new(
                &payload,
                semantic_deadline_at_unix_ms,
                timing.hard_deadline,
                || clock.now_unix_ms(),
            )
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
            if matches!(&body, wire::frame_payload::Body::EngineEventCommitted(_)) {
                let receipt = validate_engine_committed(
                    body,
                    &header,
                    &request,
                    &self.identity,
                    &self.runtime_instance_id,
                    local_sequence,
                    payload_digest.as_slice(),
                )?;
                let committed = self.channel.commit_accepted(*pending)?;
                if !committed.matches(&binding) {
                    return Err(ProviderDataError::ForeignCommitReceipt);
                }
                return Ok(receipt);
            }
            let event = self.validate_bufferable_event(body, &header)?;
            let committed = self.channel.commit_accepted(*pending)?;
            if !committed.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            self.advance_provider_event(&event)?;
            self.buffered_events.push_back(event);
        }
    }

    pub(super) fn validate_bufferable_event(
        &self,
        body: wire::frame_payload::Body,
        header: &wire::FrameHeader,
    ) -> Result<ProviderWireEvent, ProviderDataError> {
        let active = self
            .active
            .as_ref()
            .ok_or(ProviderDataError::NoActiveOperation)?;
        validate_stream_event(
            body,
            header,
            active.operation_id.as_str(),
            active.next_event_sequence,
        )
    }

    pub(super) fn advance_provider_event(
        &mut self,
        event: &ProviderWireEvent,
    ) -> Result<(), ProviderDataError> {
        if event.is_terminal() {
            self.active = None;
        } else if let Some(active) = self.active.as_mut() {
            active.next_event_sequence = active
                .next_event_sequence
                .checked_add(1)
                .ok_or(ProviderDataError::EventSequenceExhausted)?;
        }
        Ok(())
    }
}
