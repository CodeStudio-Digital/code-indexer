use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityExecutorPort, CapabilityFailure, CapabilityInvocation,
    SealedExecutionGrant,
};

use super::TurnEngine;
use crate::lifecycle::RunState;
use crate::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderToolCall,
};

impl TurnEngine {
    /// Crosses the durable started boundary, revalidates authority immediately
    /// before the effect, executes once, then commits an exact terminal record.
    /// An executor transport/runtime error after `started` is ambiguity, so it
    /// is committed as `OutcomeUnknown` and is never retried here.
    ///
    /// # Errors
    ///
    /// Returns typed authority, clock, event or lifecycle failures. Executor
    /// errors after the durable boundary are returned as a successful unknown
    /// outcome only after its terminal record is committed.
    #[allow(clippy::too_many_arguments)]
    pub async fn execute_capability<X, A, E, C>(
        &mut self,
        call: &ProviderToolCall,
        capability_set_sha256: [u8; 32],
        deadline_at_unix_ms: i64,
        grant: &SealedExecutionGrant,
        executor: &mut X,
        authority: &mut A,
        events: &mut E,
        clock: &mut C,
    ) -> Result<CapabilityExecutionOutcome, CapabilityExecutionError<A::Error, E::Error, C::Error>>
    where
        X: CapabilityExecutorPort,
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        if self.state() != RunState::CapabilityDispatch || deadline_at_unix_ms <= 0 {
            return Err(CapabilityExecutionError::InvalidState);
        }
        let invocation =
            super::capability::invocation(call, capability_set_sha256, deadline_at_unix_ms);
        if !grant_matches(grant, &invocation) {
            return Err(CapabilityExecutionError::InvalidGrant);
        }
        authority
            .verify(AuthorityCheckpoint::CapabilityDispatch)
            .await
            .map_err(CapabilityExecutionError::Authority)?;
        let started_at = clock
            .now_unix_ms()
            .await
            .map_err(CapabilityExecutionError::Clock)?;
        if started_at >= grant.expires_at_unix_ms || started_at >= deadline_at_unix_ms {
            return Err(CapabilityExecutionError::InvalidGrant);
        }
        events
            .append(EngineEvent::CapabilityDispatchStarted {
                operation_id: invocation.operation_id.as_str(),
                tool_use_id: invocation.tool_use_id.as_str(),
                grant_id: grant.grant_id.as_str(),
                effective_input_sha256: &grant.effective_input_sha256,
                started_at_unix_ms: started_at,
            })
            .await
            .map_err(CapabilityExecutionError::EventSink)?;
        let outcome = match authority
            .verify(AuthorityCheckpoint::CapabilityEffect)
            .await
        {
            Ok(()) => executor
                .execute(&invocation, grant)
                .await
                .unwrap_or_else(|_| {
                    CapabilityExecutionOutcome::OutcomeUnknown(CapabilityFailure {
                        reason_code: "executor_result_ambiguous".into(),
                        duration_ms: 0,
                    })
                }),
            Err(_) => CapabilityExecutionOutcome::Cancelled(CapabilityFailure {
                reason_code: "authority_revoked_before_effect".into(),
                duration_ms: 0,
            }),
        };
        // Do not introduce a second fallible clock read after the effect. Once
        // execution has happened, the terminal record must be attempted even
        // if the wall clock source becomes unavailable.
        let completed_at = started_at
            .saturating_add(i64::try_from(outcome_duration_ms(&outcome)).unwrap_or(i64::MAX));
        events
            .append(EngineEvent::CapabilityTerminal {
                operation_id: invocation.operation_id.as_str(),
                tool_use_id: invocation.tool_use_id.as_str(),
                grant_id: grant.grant_id.as_str(),
                outcome: &outcome,
                completed_at_unix_ms: completed_at,
            })
            .await
            .map_err(CapabilityExecutionError::EventSink)?;
        self.lifecycle
            .transition(RunState::Composing)
            .map_err(CapabilityExecutionError::Transition)?;
        Ok(outcome)
    }
}

const fn outcome_duration_ms(outcome: &CapabilityExecutionOutcome) -> u64 {
    match outcome {
        CapabilityExecutionOutcome::Succeeded(output) => output.duration_ms,
        CapabilityExecutionOutcome::Failed(failure)
        | CapabilityExecutionOutcome::Cancelled(failure)
        | CapabilityExecutionOutcome::OutcomeUnknown(failure) => failure.duration_ms,
    }
}

fn grant_matches(grant: &SealedExecutionGrant, invocation: &CapabilityInvocation) -> bool {
    if grant.effective_input_sha256 != invocation.input_sha256 {
        return false;
    }
    if grant.capability_id != invocation.capability_id
        || grant.capability_version != invocation.capability_version
        || grant.operation_id != invocation.operation_id
        || grant.tool_use_id != invocation.tool_use_id
        || grant.execution_class != invocation.execution_class
        || grant.mutates != invocation.mutates
    {
        return false;
    }
    grant.issued_at_unix_ms > 0 && grant.expires_at_unix_ms > grant.issued_at_unix_ms
}

#[derive(Debug)]
pub enum CapabilityExecutionError<A, E, C> {
    InvalidState,
    InvalidGrant,
    Authority(A),
    EventSink(E),
    Clock(C),
    Transition(crate::lifecycle::InvalidRunTransition),
}

impl<A: Display, E: Display, C: Display> Display for CapabilityExecutionError<A, E, C> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState => {
                formatter.write_str("capability execution requires dispatch state")
            }
            Self::InvalidGrant => formatter.write_str("capability execution grant is invalid"),
            Self::Authority(error) => write!(formatter, "capability authority failed: {error}"),
            Self::EventSink(error) => write!(formatter, "capability event commit failed: {error}"),
            Self::Clock(error) => write!(formatter, "capability clock failed: {error}"),
            Self::Transition(error) => Display::fmt(error, formatter),
        }
    }
}

impl<A: Error + 'static, E: Error + 'static, C: Error + 'static> Error
    for CapabilityExecutionError<A, E, C>
{
}
