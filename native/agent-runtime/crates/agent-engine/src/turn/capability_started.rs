use super::{CapabilityBatch, CapabilityExecutionError, capability_batch::BatchState};
use crate::ports::{
    AuthorityCheckpoint, AuthorityPort, ClockPort, EngineEvent, EventSinkPort, ProviderToolCall,
};
use agent_tools::capability::{CapabilityInvocation, SealedExecutionGrant};
use std::sync::Arc;

/// Linear receipt of a durable start. Cannot be manufactured, cloned, settled
/// twice, or settled against a different provider boundary.
#[derive(Debug)]
pub struct StartedCapability {
    pub(super) state: Arc<BatchState>,
    pub(super) invocation: CapabilityInvocation,
    pub(super) grant: SealedExecutionGrant,
    pub(super) started_at: i64,
}

impl StartedCapability {
    #[must_use]
    pub const fn invocation(&self) -> &CapabilityInvocation {
        &self.invocation
    }
    #[must_use]
    pub const fn grant(&self) -> &SealedExecutionGrant {
        &self.grant
    }
}

impl CapabilityBatch {
    /// Reserve and durably start one member before exposing execution inputs.
    /// # Errors
    /// Rejects foreign calls/grants, expired authority or a failed journal.
    #[allow(clippy::too_many_arguments)]
    pub async fn start<A: AuthorityPort, E: EventSinkPort, C: ClockPort>(
        &self,
        call: &ProviderToolCall,
        capability_set_sha256: [u8; 32],
        deadline_at_unix_ms: i64,
        grant: &SealedExecutionGrant,
        authority: &mut A,
        events: &mut E,
        clock: &mut C,
    ) -> Result<StartedCapability, CapabilityExecutionError<A::Error, E::Error, C::Error>> {
        if deadline_at_unix_ms <= 0 {
            return Err(CapabilityExecutionError::InvalidState);
        }
        let invocation =
            super::capability::invocation(call, capability_set_sha256, deadline_at_unix_ms);
        if !super::capability_execution::grant_matches(grant, &invocation) {
            return Err(CapabilityExecutionError::InvalidGrant);
        }
        if !self.reserve(call) {
            return Err(CapabilityExecutionError::InvalidState);
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
                operation_id: &invocation.operation_id,
                tool_use_id: &invocation.tool_use_id,
                grant_id: &grant.grant_id,
                effective_input_sha256: &grant.effective_input_sha256,
                started_at_unix_ms: started_at,
            })
            .await
            .map_err(CapabilityExecutionError::EventSink)?;
        Ok(StartedCapability {
            state: Arc::clone(&self.state),
            invocation,
            grant: grant.clone(),
            started_at,
        })
    }
}
