use super::{
    EngineEvent, EventSinkPort, OperationId, ProviderUsage, RunState, TurnEngine, TurnEngineError,
    TurnOutcome,
};
use crate::ports::ProviderToolCall;
impl TurnEngine {
    pub(super) async fn capability_boundary<P, A, E, C>(
        &mut self,
        operation_id: &str,
        call: crate::ports::ProviderToolCall,
        assistant_text: String,
        assistant_thinking: String,
        usage: Option<ProviderUsage>,
        events: &mut E,
    ) -> Result<TurnOutcome, TurnEngineError<P, A, E::Error, C>>
    where
        E: EventSinkPort,
    {
        events
            .append(EngineEvent::CapabilityBoundary {
                operation_id,
                tool_use_id: call.tool_use_id.as_str(),
                call: &call,
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        self.stage_capabilities(std::slice::from_ref(&call));
        self.advance(RunState::CapabilityDispatch)?;
        Ok(TurnOutcome::CapabilityRequired {
            call,
            assistant_text,
            assistant_thinking,
            usage,
        })
    }

    pub(super) async fn capabilities_boundary<P, A, E: EventSinkPort, C>(
        &mut self,
        operation_id: &OperationId,
        calls: Vec<ProviderToolCall>,
        assistant_text: String,
        assistant_thinking: String,
        usage: Option<ProviderUsage>,
        events: &mut E,
    ) -> Result<TurnOutcome, TurnEngineError<P, A, E::Error, C>> {
        if calls.is_empty() || calls.len() > 256 {
            return Err(TurnEngineError::InvalidContext);
        }
        let mut identifiers = std::collections::BTreeSet::new();
        for call in &calls {
            if &call.operation_id != operation_id || !identifiers.insert(call.tool_use_id.as_str())
            {
                return Err(TurnEngineError::InvalidContext);
            }
        }
        for call in &calls {
            events
                .append(EngineEvent::CapabilityBoundary {
                    operation_id: operation_id.as_str(),
                    tool_use_id: call.tool_use_id.as_str(),
                    call,
                })
                .await
                .map_err(TurnEngineError::EventSink)?;
        }
        self.stage_capabilities(&calls);
        self.advance(RunState::CapabilityDispatch)?;
        Ok(TurnOutcome::CapabilitiesRequired {
            calls,
            assistant_text,
            assistant_thinking,
            usage,
        })
    }
}
