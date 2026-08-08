use agent_protocol::frame::FrameReceiveOutcome;
use agent_protocol::generated::v1 as wire;
use tokio::io::{AsyncRead, AsyncWrite};

use super::{ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming};

mod validation;

use validation::{validate_execute, validate_execution_result, validate_prepare, validate_update};

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    /// Requests a pre-dispatch capability decision while preserving provider
    /// events that race on the shared Data stream.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid authority, correlation, decision or I/O.
    pub async fn prepare_capability<C: ProviderDataClock>(
        &mut self,
        prepare: wire::CapabilityPrepare,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::CapabilityUpdate, ProviderDataError> {
        validate_prepare(&prepare, &self.identity, &self.runtime_instance_id)?;
        let deadline = prepare.deadline_at_unix_ms;
        let operation_id = prepare.operation_id.clone();
        let tool_use_id = prepare.tool_use_id.clone();
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::CapabilityPrepare(prepare)),
        };
        let request = self
            .channel
            .send_new(&payload, deadline, timing.hard_deadline, || {
                clock.now_unix_ms()
            })
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
            if matches!(&body, wire::frame_payload::Body::CapabilityUpdate(_)) {
                let update = validate_update(
                    body,
                    &header,
                    &request,
                    &self.identity,
                    &self.runtime_instance_id,
                    &operation_id,
                    &tool_use_id,
                    clock.now_unix_ms(),
                )?;
                let receipt = self.channel.commit_accepted(*pending)?;
                if !receipt.matches(&binding) {
                    return Err(ProviderDataError::ForeignCommitReceipt);
                }
                return Ok(update);
            }
            let event = self.validate_bufferable_event(body, &header)?;
            let receipt = self.channel.commit_accepted(*pending)?;
            if !receipt.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            self.advance_provider_event(&event)?;
            self.buffered_events.push_back(event);
        }
    }

    /// Executes one already-authorized Host capability while preserving
    /// provider events that race on the shared Data stream.
    ///
    /// # Errors
    ///
    /// Fails closed on invalid authority, correlation, result shape or I/O.
    pub async fn execute_capability<C: ProviderDataClock>(
        &mut self,
        execute: wire::CapabilityExecute,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::CapabilityExecutionResult, ProviderDataError> {
        validate_execute(&execute, &self.identity, &self.runtime_instance_id)?;
        let deadline = execute.deadline_at_unix_ms;
        let operation_id = execute.operation_id.clone();
        let tool_use_id = execute.tool_use_id.clone();
        let grant_id = execute.grant_id.clone();
        let payload = wire::FramePayload {
            body: Some(wire::frame_payload::Body::CapabilityExecute(execute)),
        };
        let request = self
            .channel
            .send_new(&payload, deadline, timing.hard_deadline, || {
                clock.now_unix_ms()
            })
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
            if matches!(
                &body,
                wire::frame_payload::Body::CapabilityExecutionResult(_)
            ) {
                let result = validate_execution_result(
                    body,
                    &header,
                    &request,
                    &self.identity,
                    &self.runtime_instance_id,
                    &operation_id,
                    &tool_use_id,
                    &grant_id,
                )?;
                let receipt = self.channel.commit_accepted(*pending)?;
                if !receipt.matches(&binding) {
                    return Err(ProviderDataError::ForeignCommitReceipt);
                }
                return Ok(result);
            }
            let event = self.validate_bufferable_event(body, &header)?;
            let receipt = self.channel.commit_accepted(*pending)?;
            if !receipt.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            self.advance_provider_event(&event)?;
            self.buffered_events.push_back(event);
        }
    }
}
