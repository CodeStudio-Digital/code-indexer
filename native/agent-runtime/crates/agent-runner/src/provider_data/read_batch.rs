use super::{ProviderDataClient, ProviderDataClock, ProviderDataError, ProviderDataTiming};
use agent_protocol::{frame::FrameReceiveOutcome, generated::v1 as wire};
use std::collections::{HashSet, VecDeque};
use tokio::io::{AsyncRead, AsyncWrite};

#[cfg(test)]
mod tests;

#[derive(Debug)]
pub(super) struct ReadBatch {
    id: String,
    members: Vec<wire::CapabilityExecute>,
    received: HashSet<String>,
    ready: VecDeque<wire::CapabilityExecutionResult>,
    consumed: usize,
}

impl<S: AsyncRead + AsyncWrite + Unpin + 'static> ProviderDataClient<S> {
    /// Start one bounded, independently authorized Host read window.
    /// # Errors
    /// Rejects overlap, malformed identities, a foreign ACK, or transport loss.
    pub async fn start_read_batch<C: ProviderDataClock>(
        &mut self,
        batch: wire::CapabilityReadBatchExecute,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<(), ProviderDataError> {
        if self.active.is_some() || self.read_batch.is_some() {
            return Err(ProviderDataError::OperationAlreadyActive);
        }
        if batch.identity.as_ref() != Some(&self.identity)
            || batch.runtime_instance_id != self.runtime_instance_id
            || batch.batch_id.is_empty()
            || batch.batch_id.len() > 1024
            || !(2..=4).contains(&batch.members.len())
            || batch
                .members
                .iter()
                .map(|m| &m.operation_id)
                .collect::<HashSet<_>>()
                .len()
                != batch.members.len()
            || batch
                .members
                .iter()
                .map(|m| &m.tool_use_id)
                .collect::<HashSet<_>>()
                .len()
                != batch.members.len()
        {
            return Err(ProviderDataError::InvalidRequest(
                "read batch identity or size",
            ));
        }
        for member in &batch.members {
            super::capabilities::validation::validate_execute(
                member,
                &self.identity,
                &self.runtime_instance_id,
            )?;
        }
        let deadline = batch
            .members
            .iter()
            .map(|m| m.deadline_at_unix_ms)
            .min()
            .unwrap_or(0);
        let state = ReadBatch {
            id: batch.batch_id.clone(),
            members: batch.members.clone(),
            received: HashSet::new(),
            ready: VecDeque::new(),
            consumed: 0,
        };
        let request = self
            .channel
            .send_new(
                &wire::FramePayload {
                    body: Some(wire::frame_payload::Body::CapabilityReadBatchExecute(batch)),
                },
                deadline,
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
            let wire::frame_payload::Body::CapabilityReadBatchAccepted(accepted) = body else {
                return Err(ProviderDataError::UnexpectedPayload(
                    "expected read batch acceptance",
                ));
            };
            if header.reply_to_message_id.as_deref() != Some(request.message_id())
                || accepted.identity.as_ref() != Some(&self.identity)
                || accepted.runtime_instance_id != self.runtime_instance_id
                || accepted.batch_id != state.id
            {
                return Err(ProviderDataError::Correlation("read batch acceptance"));
            }
            if !self.channel.commit_accepted(*pending)?.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
            self.read_batch = Some(state);
            return Ok(());
        }
    }

    /// Receive the next completed member without waiting for slower members.
    /// # Errors
    /// Rejects foreign/duplicate results, invalid authority or stream loss.
    pub async fn next_read_result<C: ProviderDataClock>(
        &mut self,
        timing: ProviderDataTiming,
        clock: &C,
    ) -> Result<wire::CapabilityExecutionResult, ProviderDataError> {
        loop {
            let state = self
                .read_batch
                .as_mut()
                .ok_or(ProviderDataError::NoActiveOperation)?;
            if let Some(result) = state.ready.pop_front() {
                state.consumed += 1;
                if state.consumed == state.members.len() {
                    self.read_batch = None;
                }
                return Ok(result);
            }
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
            let wire::frame_payload::Body::CapabilityReadBatchResult(event) = body else {
                return Err(ProviderDataError::UnexpectedPayload(
                    "expected read batch result",
                ));
            };
            self.buffer_read_result(event, &header)?;
            if !self.channel.commit_accepted(*pending)?.matches(&binding) {
                return Err(ProviderDataError::ForeignCommitReceipt);
            }
        }
    }

    pub(super) fn buffer_read_result(
        &mut self,
        event: wire::CapabilityReadBatchResult,
        header: &wire::FrameHeader,
    ) -> Result<(), ProviderDataError> {
        let state = self
            .read_batch
            .as_mut()
            .ok_or(ProviderDataError::NoActiveOperation)?;
        let result = event
            .result
            .ok_or(ProviderDataError::Correlation("read batch missing result"))?;
        let member = state
            .members
            .iter()
            .find(|m| m.operation_id == result.operation_id)
            .ok_or(ProviderDataError::Correlation(
                "read batch foreign operation",
            ))?;
        if header.reply_to_message_id.is_some()
            || event.batch_id != state.id
            || event.identity.as_ref() != Some(&self.identity)
            || event.runtime_instance_id != self.runtime_instance_id
            || result.identity != member.identity
            || result.runtime_instance_id != member.runtime_instance_id
            || result.tool_use_id != member.tool_use_id
            || result.grant_id != member.grant_id
            || result.outcome.is_none()
            || !state.received.insert(result.operation_id.clone())
        {
            return Err(ProviderDataError::Correlation(
                "read batch foreign or duplicate result",
            ));
        }
        state.ready.push_back(result);
        Ok(())
    }
}
