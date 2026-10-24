use super::{ActiveEngineError, CapabilityLoop, TurnBudgetLimit};
use agent_engine::operation::OperationId;
use agent_engine::ports::{
    AuthorityPort, ClockPort, EventSinkPort, ProviderFrontierPort, ProviderGatewayPort,
    ProviderRequest,
};
use agent_tools::capability::{CapabilityGatewayPort, CapabilityReadBatchPort};
use std::sync::Arc;

impl<P, G, E, A, C, F> CapabilityLoop<'_, P, G, E, A, C, F>
where
    P: ProviderGatewayPort,
    G: CapabilityGatewayPort + CapabilityReadBatchPort + Clone + Sync,
    E: EventSinkPort,
    A: AuthorityPort,
    C: ClockPort,
    F: ProviderFrontierPort,
{
    pub(super) async fn pause_at_limit(
        &mut self,
        limit: TurnBudgetLimit,
        turn: u64,
    ) -> Result<(), ActiveEngineError> {
        self.frontier
            .checkpoint(ProviderRequest {
                operation_id: OperationId::new(format!(
                    "{}:{}:{turn}",
                    limit.reason_code(),
                    self.attempt_id
                ))
                .map_err(|_| ActiveEngineError::InvalidOperation)?,
                encoded_context: Arc::clone(self.provider_context),
                deadline_at_unix_ms: self.deadline_at_unix_ms,
            })
            .await
            .map_err(|_| ActiveEngineError::CapabilityContextFailed)?;
        self.engine
            .pause_at_budget_limit(limit, self.authority, self.events)
            .await
            .map_err(|_| ActiveEngineError::TurnFailed)
    }
}
