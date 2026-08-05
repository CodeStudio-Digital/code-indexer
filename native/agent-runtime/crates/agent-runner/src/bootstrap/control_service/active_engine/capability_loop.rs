use std::sync::Arc;

use agent_engine::operation::OperationId;
use agent_engine::ports::{AuthorityPort, ClockPort, EventSinkPort, ProviderGatewayPort};
use agent_engine::turn::{TurnEngine, TurnInput, TurnOutcome};
use agent_tools::capability::{CapabilityDecision, CapabilityGatewayPort};

use super::error::ActiveEngineError;
use crate::native_tools::NativeToolExecutor;
use crate::provider_context::compose_capability_result_context;

pub(super) struct CapabilityLoop<'a, P, G, E, A, C> {
    pub engine: &'a mut TurnEngine,
    pub provider: &'a mut P,
    pub capabilities: &'a mut G,
    pub events: &'a mut E,
    pub authority: &'a mut A,
    pub clock: &'a mut C,
    pub provider_context: &'a mut Arc<[u8]>,
    pub capability_set_sha256: [u8; 32],
    pub deadline_at_unix_ms: i64,
    pub maximum_context_bytes: usize,
    pub maximum_turns: u64,
    pub maximum_tool_calls: u64,
    pub attempt_id: &'a str,
}

impl<P, G, E, A, C> CapabilityLoop<'_, P, G, E, A, C>
where
    P: ProviderGatewayPort,
    G: CapabilityGatewayPort,
    E: EventSinkPort,
    A: AuthorityPort,
    C: ClockPort,
{
    pub(super) async fn drive(
        &mut self,
        mut outcome: TurnOutcome,
    ) -> Result<(), ActiveEngineError> {
        let mut provider_turns = 1_u64;
        let mut tool_calls = 0_u64;
        while let TurnOutcome::CapabilityRequired {
            call,
            assistant_text,
            usage: _,
        } = outcome
        {
            tool_calls = next_within(tool_calls, self.maximum_tool_calls)?;
            let next_provider_turn = next_within(provider_turns, self.maximum_turns)?;
            let decision = self
                .engine
                .prepare_capability(
                    &call,
                    self.capability_set_sha256,
                    self.deadline_at_unix_ms,
                    self.capabilities,
                    self.authority,
                )
                .await
                .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?;
            let CapabilityDecision::Accepted(grant) = decision else {
                break;
            };
            let mut executor = NativeToolExecutor;
            let capability_outcome = self
                .engine
                .execute_capability(
                    &call,
                    self.capability_set_sha256,
                    self.deadline_at_unix_ms,
                    &grant,
                    &mut executor,
                    self.authority,
                    self.events,
                    self.clock,
                )
                .await
                .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?;
            *self.provider_context = compose_capability_result_context(
                self.provider_context.as_ref(),
                &call,
                assistant_text.as_str(),
                &capability_outcome,
                self.maximum_context_bytes,
            )
            .map(Into::into)
            .map_err(|_| ActiveEngineError::CapabilityContextFailed)?;
            provider_turns = next_provider_turn;
            outcome = self
                .engine
                .resume_after_capability(
                    TurnInput {
                        operation_id: next_operation(self.attempt_id, provider_turns)?,
                        encoded_context: Arc::clone(self.provider_context),
                        deadline_at_unix_ms: self.deadline_at_unix_ms,
                    },
                    self.provider,
                    self.authority,
                    self.events,
                    self.clock,
                )
                .await
                .map_err(|_| ActiveEngineError::TurnFailed)?;
        }
        Ok(())
    }
}

fn next_within(current: u64, maximum: u64) -> Result<u64, ActiveEngineError> {
    let next = current
        .checked_add(1)
        .ok_or(ActiveEngineError::RunBudgetExceeded)?;
    if next > maximum {
        return Err(ActiveEngineError::RunBudgetExceeded);
    }
    Ok(next)
}

fn next_operation(attempt_id: &str, turn: u64) -> Result<OperationId, ActiveEngineError> {
    OperationId::new(format!("provider-turn:{attempt_id}:{turn}"))
        .map_err(|_| ActiveEngineError::InvalidOperation)
}
