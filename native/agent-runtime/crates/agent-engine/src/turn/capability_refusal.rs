use super::{CapabilityBatch, CapabilityExecutionError};
use crate::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderToolCall,
};
use agent_tools::capability::{CapabilityExecutionOutcome, CapabilityFailure, CapabilityRejection};

impl CapabilityBatch {
    /// Settles a rejected invocation durably without granting or starting an effect.
    ///
    /// # Errors
    /// Rejects stale authority, invalid policy metadata, duplicate members or failed commits.
    pub async fn refuse<A, E, C>(
        &self,
        call: &ProviderToolCall,
        rejection: &CapabilityRejection,
        deadline: i64,
        authority: &mut A,
        events: &mut E,
        clock: &mut C,
    ) -> Result<CapabilityExecutionOutcome, CapabilityExecutionError<A::Error, E::Error, C::Error>>
    where
        A: AuthorityPort,
        E: EventSinkPort,
        C: ClockPort,
    {
        authority
            .verify(AuthorityCheckpoint::CapabilityPrepare)
            .await
            .map_err(CapabilityExecutionError::Authority)?;
        let now = clock
            .now_unix_ms()
            .await
            .map_err(CapabilityExecutionError::Clock)?;
        if now >= deadline
            || rejection.decided_at_unix_ms <= 0
            || rejection.decided_at_unix_ms > now.saturating_add(50)
            || [
                &rejection.decision_id,
                &rejection.reason_code,
                &rejection.policy_version,
            ]
            .iter()
            .any(|value| value.is_empty() || value.len() > 1024 || value.contains('\0'))
        {
            return Err(CapabilityExecutionError::InvalidGrant);
        }
        if !self.reserve(call) {
            return Err(CapabilityExecutionError::InvalidState);
        }
        let operation_id = super::capability::operation_id(call);
        events
            .append(EngineEvent::CapabilityRefused {
                operation_id: &operation_id,
                tool_use_id: call.tool_use_id.as_str(),
                rejection,
            })
            .await
            .map_err(CapabilityExecutionError::EventSink)?;
        self.mark_settled();
        Ok(CapabilityExecutionOutcome::Failed(CapabilityFailure {
            reason_code: format!("capability_rejected:{}", rejection.reason_code),
            duration_ms: 0,
        }))
    }
}
