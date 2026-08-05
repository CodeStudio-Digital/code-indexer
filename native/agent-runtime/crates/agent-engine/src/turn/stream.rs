use super::{TurnEngine, TurnEngineError, TurnOutcome};
use crate::lifecycle::RunState;
use crate::operation::OperationId;
use crate::ports::{
    AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderEvent, ProviderGatewayPort,
    ProviderUsage, TerminalClassification,
};

mod thinking;

pub(super) struct StreamPorts<'a, P, A, E, C> {
    pub provider: &'a mut P,
    pub authority: &'a mut A,
    pub events: &'a mut E,
    pub clock: &'a mut C,
}

impl TurnEngine {
    pub(super) async fn consume_stream<P, A, E, C>(
        &mut self,
        operation_id: OperationId,
        operation: &mut P::Operation,
        deadline_at_unix_ms: i64,
        ports: &mut StreamPorts<'_, P, A, E, C>,
    ) -> Result<TurnOutcome, TurnEngineError<P::Error, A::Error, E::Error, C::Error>>
    where
        P: ProviderGatewayPort,
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        let mut text = String::new();
        let mut usage = None;
        for _ in 0..self.limits.max_provider_events() {
            if self.expired(deadline_at_unix_ms, ports.clock).await? {
                return self.provider_deadline_exceeded(usage, ports.events).await;
            }
            let Some(event) = ports
                .provider
                .next(operation)
                .await
                .map_err(TurnEngineError::Provider)?
            else {
                return self
                    .terminal(
                        ports.events,
                        TerminalClassification::Failed,
                        "unexpected_provider_eof",
                        usage,
                    )
                    .await;
            };
            match event {
                ProviderEvent::TextDelta(delta) => {
                    if let Some(outcome) = self
                        .accept_delta(operation_id.as_str(), &mut text, delta, usage, ports)
                        .await?
                    {
                        return Ok(outcome);
                    }
                }
                ProviderEvent::ThinkingDelta(delta) => {
                    if let Some(outcome) = self
                        .accept_thinking(operation_id.as_str(), delta, usage, ports)
                        .await?
                    {
                        return Ok(outcome);
                    }
                }
                ProviderEvent::Usage(next) => {
                    if let Some(outcome) = self.accept_usage(next, usage, ports).await? {
                        return Ok(outcome);
                    }
                    usage = Some(next);
                    ports
                        .events
                        .append(EngineEvent::ProviderUsage {
                            operation_id: operation_id.as_str(),
                            usage: next,
                        })
                        .await
                        .map_err(TurnEngineError::EventSink)?;
                }
                ProviderEvent::ToolCall(call) => {
                    return self
                        .capability_boundary(operation_id.as_str(), call, text, usage, ports.events)
                        .await;
                }
                ProviderEvent::Completed {
                    response_id,
                    response_message_count: _,
                } => {
                    return self
                        .complete(
                            operation_id.as_str(),
                            response_id,
                            text,
                            usage,
                            ports.authority,
                            ports.events,
                        )
                        .await;
                }
                ProviderEvent::Failed { reason_code } => {
                    return self
                        .provider_failed(reason_code.as_str(), usage, ports.events)
                        .await;
                }
                ProviderEvent::Interrupted { reason_code } => {
                    return self
                        .provider_interrupted(reason_code.as_str(), usage, ports.events)
                        .await;
                }
            }
        }
        self.terminal(
            ports.events,
            TerminalClassification::Interrupted,
            "provider_event_limit_exceeded",
            usage,
        )
        .await
    }

    async fn capability_boundary<P, A, E, C>(
        &mut self,
        operation_id: &str,
        call: crate::ports::ProviderToolCall,
        assistant_text: String,
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
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        self.advance(RunState::CapabilityDispatch)?;
        Ok(TurnOutcome::CapabilityRequired {
            call,
            assistant_text,
            usage,
        })
    }

    async fn accept_delta<P, A, E, C>(
        &mut self,
        operation_id: &str,
        text: &mut String,
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
                    "invalid_provider_delta",
                    usage,
                )
                .await
                .map(Some);
        }
        if text.len().saturating_add(delta.len()) > self.limits.max_response_bytes() {
            return self
                .terminal(
                    ports.events,
                    TerminalClassification::Interrupted,
                    "response_bytes_exceeded",
                    usage,
                )
                .await
                .map(Some);
        }
        ports
            .events
            .append(EngineEvent::ProviderDelta {
                operation_id,
                text: delta.as_str(),
            })
            .await
            .map_err(TurnEngineError::EventSink)?;
        text.push_str(delta.as_str());
        Ok(None)
    }

    async fn accept_usage<P, A, E, C>(
        &mut self,
        next: ProviderUsage,
        usage: Option<ProviderUsage>,
        ports: &mut StreamPorts<'_, P, A, E, C>,
    ) -> Result<Option<TurnOutcome>, TurnEngineError<P::Error, A::Error, E::Error, C::Error>>
    where
        P: ProviderGatewayPort,
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        if usage.is_some_and(|previous| !next.follows(previous)) {
            return self
                .terminal(
                    ports.events,
                    TerminalClassification::Failed,
                    "invalid_provider_usage",
                    usage,
                )
                .await
                .map(Some);
        }
        if !self.limits.usage_within_budget(next) {
            return self
                .terminal(
                    ports.events,
                    TerminalClassification::Interrupted,
                    "provider_budget_exceeded",
                    Some(next),
                )
                .await
                .map(Some);
        }
        Ok(None)
    }
}
