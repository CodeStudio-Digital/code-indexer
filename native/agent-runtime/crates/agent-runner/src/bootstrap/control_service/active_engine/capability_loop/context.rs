use super::{ActiveEngineError, CapabilityLoop};
use crate::provider_context::{compact_encoded_context, compose_capability_results_context};
use agent_engine::operation::OperationId;
use agent_engine::ports::ProviderToolCall;
use agent_engine::ports::{ProviderFrontierPort, ProviderRequest};
use agent_protocol::generated::v1 as wire;
use agent_tools::capability::CapabilityExecutionOutcome;
use prost::Message;
use std::sync::Arc;

impl<P, G, E, A, C, F> CapabilityLoop<'_, P, G, E, A, C, F> {
    pub(super) fn update_context(
        &mut self,
        pending: (&[ProviderToolCall], &str, &str),
        results: &[CapabilityExecutionOutcome],
    ) -> Result<(), ActiveEngineError> {
        let (calls, text, thinking) = pending;
        *self.provider_context = compose_capability_results_context(
            self.provider_context.as_ref(),
            calls,
            text,
            thinking,
            results,
            self.maximum_context_bytes,
        )
        .and_then(|encoded| {
            compact_encoded_context(&encoded, self.session_id, self.maximum_context_bytes)
        })
        .map(Into::into)
        .map_err(|_| ActiveEngineError::CapabilityContextFailed)?;
        Ok(())
    }
}

impl<P, G, E, A, C, F: ProviderFrontierPort> CapabilityLoop<'_, P, G, E, A, C, F> {
    pub(super) async fn checkpoint_compaction(
        &mut self,
        turn: u64,
    ) -> Result<(), ActiveEngineError> {
        let context = wire::ProviderTurnContext::decode(self.provider_context.as_ref())
            .map_err(|_| ActiveEngineError::CapabilityContextFailed)?;
        if context.pending_chapters.is_empty() {
            return Ok(());
        }
        self.frontier
            .checkpoint(ProviderRequest {
                operation_id: OperationId::new(format!("compact:{}:{turn}", self.attempt_id))
                    .map_err(|_| ActiveEngineError::InvalidOperation)?,
                encoded_context: Arc::clone(self.provider_context),
                deadline_at_unix_ms: self.deadline_at_unix_ms,
            })
            .await
            .map_err(|_| ActiveEngineError::CapabilityContextFailed)
    }
}
