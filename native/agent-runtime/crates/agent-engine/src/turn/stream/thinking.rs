use super::{StreamPorts, TurnEngine, TurnEngineError, TurnOutcome};
use crate::ports::{
    AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderGatewayPort, ProviderUsage,
    TerminalClassification,
};

impl TurnEngine {
    pub(super) async fn accept_thinking<P, A, E, C>(
        &mut self,
        operation_id: &str,
        delta: String,
        usage: Option<ProviderUsage>,
        ports: &mut StreamPorts<'_, P, A, E, C>,
    ) -> Result<Option<TurnOutcome>, TurnEngineError<P::Error, A::Error, E::Error, C::Error>>
    where
        P: ProviderGatewayPort,
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        if delta.is_empty() || delta.len() > self.limits.max_provider_event_bytes() {
            return self
                .terminal(
                    ports.events,
                    TerminalClassification::Failed,
                    "invalid_provider_thinking_delta",
                    usage,
                )
                .await
                .map(Some);
        }
        ports
            .events
            .append(EngineEvent::ProviderThinkingDelta {
                operation_id,
                text: delta.as_str(),
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        Ok(None)
    }
}
