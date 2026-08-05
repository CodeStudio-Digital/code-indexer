use super::{StreamPorts, TurnEngine, TurnEngineError, TurnInput, TurnOutcome};
use crate::lifecycle::RunState;
use crate::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderGatewayPort,
    ProviderRequest,
};

impl TurnEngine {
    /// Starts the next provider operation after a capability terminal record
    /// returned the engine to `Composing`.
    ///
    /// # Errors
    ///
    /// Fails closed on an invalid lifecycle state, context, deadline,
    /// authority, provider operation, event commit or clock observation.
    pub async fn resume_after_capability<P, A, E, C>(
        &mut self,
        input: TurnInput,
        provider: &mut P,
        authority: &mut A,
        events: &mut E,
        clock: &mut C,
    ) -> Result<TurnOutcome, TurnEngineError<P::Error, A::Error, E::Error, C::Error>>
    where
        P: ProviderGatewayPort,
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        if self.state() != RunState::Composing {
            return Err(TurnEngineError::InvalidState);
        }
        if input.encoded_context.is_empty()
            || input.encoded_context.len() > self.limits.max_context_bytes()
        {
            return Err(TurnEngineError::InvalidContext);
        }
        if input.deadline_at_unix_ms <= 0 {
            return Err(TurnEngineError::InvalidDeadline);
        }
        if self.expired(input.deadline_at_unix_ms, clock).await? {
            return self
                .terminal(
                    events,
                    crate::ports::TerminalClassification::Interrupted,
                    "deadline_exceeded",
                    None,
                )
                .await;
        }
        authority
            .verify(AuthorityCheckpoint::ProviderStart)
            .await
            .map_err(TurnEngineError::Authority)?;
        let operation_id = input.operation_id;
        let mut operation = provider
            .start(ProviderRequest {
                operation_id: operation_id.clone(),
                encoded_context: input.encoded_context,
                deadline_at_unix_ms: input.deadline_at_unix_ms,
            })
            .await
            .map_err(TurnEngineError::Provider)?;
        self.advance(RunState::ProviderStream)?;
        events
            .append(EngineEvent::ProviderStarted {
                operation_id: operation_id.as_str(),
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        let mut ports = StreamPorts {
            provider,
            authority,
            events,
            clock,
        };
        self.consume_stream(
            operation_id,
            &mut operation,
            input.deadline_at_unix_ms,
            &mut ports,
        )
        .await
    }
}
