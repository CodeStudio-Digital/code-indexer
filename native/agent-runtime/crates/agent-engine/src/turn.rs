mod budget;
mod capability;
mod capability_batch;
mod capability_execution;
mod capability_refusal;
mod capability_started;
mod model;
mod resume;
mod stream;
mod terminal;

pub use budget::TurnBudgetLimit;
pub use capability::CapabilityPrepareError;
pub use capability_batch::CapabilityBatch;
pub use capability_execution::CapabilityExecutionError;
pub use capability_started::StartedCapability;
pub use model::{TurnEngineError, TurnInput, TurnOutcome};

use crate::lifecycle::{RunLifecycle, RunState};
use crate::limits::EngineLimits;
use crate::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderGatewayPort,
    ProviderRequest, TerminalClassification,
};
use stream::StreamPorts;

#[derive(Debug)]
pub struct TurnEngine {
    pub(super) lifecycle: RunLifecycle,
    pub(super) limits: EngineLimits,
    capability_boundary: Option<std::sync::Arc<capability_batch::BatchState>>,
}

impl TurnEngine {
    #[must_use]
    pub fn new(limits: EngineLimits) -> Self {
        Self {
            lifecycle: RunLifecycle::default(),
            limits,
            capability_boundary: None,
        }
    }

    #[must_use]
    pub const fn state(&self) -> RunState {
        self.lifecycle.state()
    }

    /// Executes one bounded provider turn through typed ports.
    ///
    /// # Errors
    ///
    /// Returns a typed port, input or lifecycle failure. Semantic provider
    /// failures and limits are committed as [`TurnOutcome`] values.
    pub async fn run<P, A, E, C>(
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
        if input.encoded_context.is_empty()
            || input.encoded_context.len() > self.limits.max_context_bytes()
        {
            return Err(TurnEngineError::InvalidContext);
        }
        if input.deadline_at_unix_ms <= 0 {
            return Err(TurnEngineError::InvalidDeadline);
        }
        self.advance(RunState::Hydrating)?;
        authority
            .verify(AuthorityCheckpoint::Hydration)
            .await
            .map_err(TurnEngineError::Authority)?;
        self.advance(RunState::Ready)?;
        self.advance(RunState::Composing)?;
        if self.expired(input.deadline_at_unix_ms, clock).await? {
            return self
                .terminal(
                    events,
                    TerminalClassification::Interrupted,
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
