use super::super::capability_scheduler::execute_window;
use super::{ActiveEngineError, CapabilityLoop};
use agent_engine::ports::{
    AuthorityPort, ClockPort, EventSinkPort, ProviderFrontierPort, ProviderGatewayPort,
    ProviderToolCall,
};
use agent_engine::turn::CapabilityBatch;
use agent_tools::capability::{
    CapabilityDecision, CapabilityExecutionOutcome, CapabilityGatewayPort, CapabilityReadBatchPort,
    SealedExecutionGrant,
};

struct PreparedWindow {
    accepted: Vec<ProviderToolCall>,
    grants: Vec<SealedExecutionGrant>,
    settled: Vec<Option<CapabilityExecutionOutcome>>,
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
    async fn execution_expired(&mut self) -> Result<bool, ActiveEngineError> {
        let now = self
            .clock
            .now_unix_ms()
            .await
            .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?;
        Ok(now <= 0 || now >= self.deadline_at_unix_ms)
    }

    pub(super) async fn interrupt_batch(
        &mut self,
        batch: CapabilityBatch,
    ) -> Result<(), ActiveEngineError> {
        self.engine
            .interrupt_capability_batch(batch, self.events)
            .await
            .map_err(|_| ActiveEngineError::CapabilityExecutionFailed)
    }

    pub(super) async fn run_window(
        &mut self,
        batch: &CapabilityBatch,
        calls: &[ProviderToolCall],
    ) -> Result<Option<Vec<CapabilityExecutionOutcome>>, ActiveEngineError> {
        if self.execution_expired().await? {
            return Ok(None);
        }
        let PreparedWindow {
            accepted,
            grants,
            settled,
        } = self.prepare_window(batch, calls).await?;
        if self.execution_expired().await? {
            return Ok(None);
        }
        let execution = execute_window(
            batch,
            &accepted,
            &grants,
            self.capability_set_sha256,
            self.deadline_at_unix_ms,
            self.capabilities,
            self.authority,
            self.events,
            self.clock,
        )
        .await;
        let executed = match execution {
            Ok(results) => results,
            Err(_) if self.execution_expired().await? => return Ok(None),
            Err(error) => return Err(error),
        };
        let mut executed = executed.into_iter();
        settled
            .into_iter()
            .map(|result| {
                result
                    .or_else(|| executed.next())
                    .ok_or(ActiveEngineError::CapabilityExecutionFailed)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Some)
    }

    async fn prepare_window(
        &mut self,
        batch: &CapabilityBatch,
        calls: &[ProviderToolCall],
    ) -> Result<PreparedWindow, ActiveEngineError> {
        let mut window = PreparedWindow {
            accepted: Vec::with_capacity(calls.len()),
            grants: Vec::with_capacity(calls.len()),
            settled: Vec::with_capacity(calls.len()),
        };
        for call in calls {
            if self.execution_expired().await? {
                break;
            }
            let decision = self
                .engine
                .prepare_capability(
                    call,
                    self.capability_set_sha256,
                    self.deadline_at_unix_ms,
                    self.capabilities,
                    self.authority,
                )
                .await
                .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?;
            match decision {
                CapabilityDecision::Accepted(grant) => {
                    window.grants.push(*grant);
                    window.accepted.push(call.clone());
                    window.settled.push(None);
                }
                CapabilityDecision::Rejected(rejection) => {
                    let result = batch
                        .refuse(
                            call,
                            &rejection,
                            self.settlement_deadline_at_unix_ms,
                            self.authority,
                            self.events,
                            self.clock,
                        )
                        .await
                        .map_err(|_| ActiveEngineError::CapabilityPrepareFailed)?;
                    window.settled.push(Some(result));
                }
                CapabilityDecision::ApprovalRequired(_) => {
                    return Err(ActiveEngineError::CapabilityPrepareFailed);
                }
            }
        }
        Ok(window)
    }
}
