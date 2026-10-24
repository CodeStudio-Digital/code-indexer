use super::{ActiveEngineError, CapabilityLoop};
use agent_engine::operation::OperationId;
use agent_engine::ports::{
    AuthorityPort, ClockPort, EventSinkPort, ProviderFrontierPort, ProviderGatewayPort,
    ProviderRequest, ProviderToolCall,
};
use agent_engine::turn::CapabilityBatch;
use agent_tools::capability::{
    CapabilityExecutionOutcome, CapabilityGatewayPort, CapabilityReadBatchPort, CapabilityRejection,
};
use std::sync::Arc;

pub(super) fn transition_requested(
    calls: &[ProviderToolCall],
    results: &[CapabilityExecutionOutcome],
) -> Result<bool, ActiveEngineError> {
    let mut requested = false;
    for (call, result) in calls.iter().zip(results) {
        let CapabilityExecutionOutcome::Succeeded(output) = result else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.encoded_result) else {
            continue;
        };
        let Some(receipt) = value.get("nativeWorktreeTransition") else {
            continue;
        };
        let id = receipt
            .get("id")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let action = receipt
            .get("action")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        if requested
            || calls.len() != 1
            || call.parallel_safe
            || !call.mutates
            || value.get("isError").and_then(serde_json::Value::as_bool) != Some(false)
            || receipt.get("version").and_then(serde_json::Value::as_u64) != Some(1)
            || receipt.get("toolName").and_then(serde_json::Value::as_str)
                != Some(call.capability_name.as_str())
            || id.len() != 64
            || !id.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !(call.capability_name == "enter_worktree" && action == "enter"
                || call.capability_name == "exit_worktree" && matches!(action, "keep" | "remove"))
        {
            return Err(ActiveEngineError::CapabilityContextFailed);
        }
        requested = true;
    }
    Ok(requested)
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
    pub(super) async fn pause_for_workspace(
        &mut self,
        batch: CapabilityBatch,
        pending: (&[ProviderToolCall], &str, &str),
        mut results: Vec<CapabilityExecutionOutcome>,
        offset: usize,
        turn: u64,
    ) -> Result<(), ActiveEngineError> {
        let now = self
            .clock
            .now_unix_ms()
            .await
            .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?;
        // Every result remains paired, but none of these calls is dispatched in
        // a directory different from the one sealed with the provider request.
        for (index, call) in pending.0.iter().enumerate().skip(offset) {
            let rejection = CapabilityRejection {
                decision_id: format!("workspace-transition:{}:{turn}:{index}", self.attempt_id),
                reason_code: "workspace_transition".to_owned(),
                policy_version: "sealed-workspace-transition:v1".to_owned(),
                decided_at_unix_ms: now,
            };
            results.push(
                batch
                    .refuse(
                        call,
                        &rejection,
                        self.settlement_deadline_at_unix_ms,
                        self.authority,
                        self.events,
                        self.clock,
                    )
                    .await
                    .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?,
            );
        }
        self.engine
            .finish_capability_batch(batch)
            .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?;
        self.update_context(pending, &results)?;
        self.frontier
            .checkpoint(ProviderRequest {
                operation_id: OperationId::new(format!(
                    "workspace-transition:{}:{turn}",
                    self.attempt_id
                ))
                .map_err(|_| ActiveEngineError::InvalidOperation)?,
                encoded_context: Arc::clone(self.provider_context),
                deadline_at_unix_ms: self.deadline_at_unix_ms,
            })
            .await
            .map_err(|_| ActiveEngineError::CapabilityContextFailed)?;
        self.engine
            .pause_at_workspace_transition(self.authority, self.events)
            .await
            .map_err(|_| ActiveEngineError::TurnFailed)
    }
}
