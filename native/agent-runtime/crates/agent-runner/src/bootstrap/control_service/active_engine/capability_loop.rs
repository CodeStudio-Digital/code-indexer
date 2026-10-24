use std::sync::Arc;

use agent_engine::operation::OperationId;
use agent_engine::ports::{
    AuthorityPort, ClockPort, EventSinkPort, ProviderFrontierPort, ProviderGatewayPort,
    ProviderToolCall,
};
use agent_engine::turn::{TurnBudgetLimit, TurnEngine, TurnInput, TurnOutcome};
use agent_tools::capability::{CapabilityGatewayPort, CapabilityReadBatchPort};

use super::capability_scheduler::window_size;
use super::error::ActiveEngineError;
mod budget;
mod context;
mod pause;
mod window;
mod workspace;

pub(super) struct CapabilityLoop<'a, P, G, E, A, C, F> {
    pub engine: &'a mut TurnEngine,
    pub provider: &'a mut P,
    pub frontier: &'a mut F,
    pub capabilities: &'a mut G,
    pub events: &'a mut E,
    pub authority: &'a mut A,
    pub clock: &'a mut C,
    pub provider_context: &'a mut Arc<[u8]>,
    pub capability_set_sha256: [u8; 32],
    pub deadline_at_unix_ms: i64,
    pub settlement_deadline_at_unix_ms: i64,
    pub maximum_context_bytes: usize,
    pub maximum_turns: u64,
    pub maximum_tool_calls: u64,
    pub maximum_concurrent_tools: usize,
    pub attempt_id: &'a str,
    pub session_id: &'a str,
}

impl<P, G, E, A, C, F> CapabilityLoop<'_, P, G, E, A, C, F>
where
    P: ProviderGatewayPort,
    G: CapabilityGatewayPort + CapabilityReadBatchPort + Clone + Sync,
    E: EventSinkPort,
    A: AuthorityPort,
    C: ClockPort,
    F: ProviderFrontierPort,
{
    pub(super) async fn drive(
        &mut self,
        mut outcome: TurnOutcome,
    ) -> Result<(), ActiveEngineError> {
        let mut provider_turns = 1_u64;
        let mut tool_calls = 0_u64;
        while let Some((calls, assistant_text, assistant_thinking)) = pending_calls(outcome) {
            // Reserve the whole response before crossing any effect boundary.
            let Some(reserved) = budget::reserve(tool_calls, calls.len(), self.maximum_tool_calls)
            else {
                return self
                    .refuse_at_tool_limit(
                        (&calls, &assistant_text, &assistant_thinking),
                        provider_turns,
                    )
                    .await;
            };
            tool_calls = reserved;
            let batch = self
                .engine
                .capability_batch()
                .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?;
            let mut results = Vec::with_capacity(calls.len());
            let mut offset = 0;
            while offset < calls.len() {
                let count =
                    window_size(&calls[offset..]).min(self.maximum_concurrent_tools.clamp(1, 4));
                let window = &calls[offset..offset + count];
                let Some(window_results) = self.run_window(&batch, window).await? else {
                    return self.interrupt_batch(batch).await;
                };
                results.extend(window_results);
                // An unknown effect cannot authorize subsequent model-driven
                // mutations or another provider turn that may repeat it.
                if results.iter().any(|result| {
                    matches!(
                        result,
                        agent_tools::capability::CapabilityExecutionOutcome::OutcomeUnknown(_)
                            | agent_tools::capability::CapabilityExecutionOutcome::Cancelled(_)
                    )
                }) {
                    return self.interrupt_batch(batch).await;
                }
                offset += count;
                if workspace::transition_requested(
                    &calls[offset - count..offset],
                    &results[results.len() - count..],
                )? {
                    return self
                        .pause_for_workspace(
                            batch,
                            (&calls, &assistant_text, &assistant_thinking),
                            results,
                            offset,
                            provider_turns,
                        )
                        .await;
                }
            }
            self.engine
                .finish_capability_batch(batch)
                .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?;
            self.update_context((&calls, &assistant_text, &assistant_thinking), &results)?;
            self.checkpoint_compaction(provider_turns).await?;
            if provider_turns >= self.maximum_turns {
                return self
                    .pause_at_limit(TurnBudgetLimit::Turns, provider_turns)
                    .await;
            }
            provider_turns = next_within(provider_turns, self.maximum_turns)?;
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

fn pending_calls(outcome: TurnOutcome) -> Option<(Vec<ProviderToolCall>, String, String)> {
    match outcome {
        TurnOutcome::CapabilityRequired {
            call,
            assistant_text,
            assistant_thinking,
            ..
        } => Some((vec![call], assistant_text, assistant_thinking)),
        TurnOutcome::CapabilitiesRequired {
            calls,
            assistant_text,
            assistant_thinking,
            ..
        } => Some((calls, assistant_text, assistant_thinking)),
        _ => None,
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
