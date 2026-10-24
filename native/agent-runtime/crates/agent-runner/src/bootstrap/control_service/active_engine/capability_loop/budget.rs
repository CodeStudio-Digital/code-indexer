use super::{ActiveEngineError, CapabilityLoop, TurnBudgetLimit};
use agent_engine::ports::{
    AuthorityPort, ClockPort, EventSinkPort, ProviderFrontierPort, ProviderGatewayPort,
    ProviderToolCall,
};
use agent_tools::capability::{
    CapabilityGatewayPort, CapabilityReadBatchPort, CapabilityRejection,
};

impl<P, G, E, A, C, F> CapabilityLoop<'_, P, G, E, A, C, F>
where
    P: ProviderGatewayPort,
    G: CapabilityGatewayPort + CapabilityReadBatchPort + Clone + Sync,
    E: EventSinkPort,
    A: AuthorityPort,
    C: ClockPort,
    F: ProviderFrontierPort,
{
    pub(super) async fn refuse_at_tool_limit(
        &mut self,
        pending: (&[ProviderToolCall], &str, &str),
        turn: u64,
    ) -> Result<(), ActiveEngineError> {
        let (calls, assistant_text, assistant_thinking) = pending;
        let batch = self
            .engine
            .capability_batch()
            .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)?;
        let decided_at_unix_ms = self
            .clock
            .now_unix_ms()
            .await
            .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?;
        let mut results = Vec::with_capacity(calls.len());
        for (index, call) in calls.iter().enumerate() {
            let rejection = CapabilityRejection {
                decision_id: format!("tool-budget:{}:{turn}:{index}", self.attempt_id),
                reason_code: TurnBudgetLimit::ToolCalls.reason_code().to_owned(),
                policy_version: "sealed-run-tree-budget:v1".to_owned(),
                decided_at_unix_ms,
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
        self.update_context((calls, assistant_text, assistant_thinking), &results)?;
        self.pause_at_limit(TurnBudgetLimit::ToolCalls, turn).await
    }
}

pub(super) fn reserve(current: u64, count: usize, maximum: u64) -> Option<u64> {
    current
        .checked_add(u64::try_from(count).ok()?)
        .filter(|next| *next <= maximum)
}
