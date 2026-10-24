use std::error::Error;
use std::fmt::{self, Display, Formatter};

use agent_tools::capability::{CapabilityDecision, CapabilityGatewayPort, CapabilityInvocation};

use super::TurnEngine;
use crate::lifecycle::RunState;
use crate::ports::{AuthorityCheckpoint, AuthorityPort, ProviderToolCall};

impl TurnEngine {
    /// Requests a policy/resource-binding decision for a completed provider
    /// tool call. This method never dispatches the capability.
    ///
    /// # Errors
    ///
    /// Returns a typed state, authority or gateway failure.
    pub async fn prepare_capability<G, A>(
        &mut self,
        call: &ProviderToolCall,
        capability_set_sha256: [u8; 32],
        deadline_at_unix_ms: i64,
        gateway: &mut G,
        authority: &mut A,
    ) -> Result<CapabilityDecision, CapabilityPrepareError<G::Error, A::Error>>
    where
        G: CapabilityGatewayPort,
        A: AuthorityPort,
    {
        if self.state() != RunState::CapabilityDispatch || deadline_at_unix_ms <= 0 {
            return Err(CapabilityPrepareError::InvalidState);
        }
        authority
            .verify(AuthorityCheckpoint::CapabilityPrepare)
            .await
            .map_err(CapabilityPrepareError::Authority)?;
        let invocation = invocation(call, capability_set_sha256, deadline_at_unix_ms);
        gateway
            .prepare(invocation)
            .await
            .map_err(CapabilityPrepareError::Gateway)
    }
}

pub(super) fn invocation(
    call: &ProviderToolCall,
    capability_set_sha256: [u8; 32],
    deadline_at_unix_ms: i64,
) -> CapabilityInvocation {
    CapabilityInvocation {
        operation_id: operation_id(call),
        provider_operation_id: call.operation_id.as_str().to_owned(),
        tool_use_id: call.tool_use_id.as_str().to_owned(),
        capability_id: call.capability_id.clone(),
        capability_version: call.capability_version.clone(),
        execution_class: call.execution_class,
        mutates: call.mutates,
        encoded_json_input: call.encoded_arguments.clone(),
        input_sha256: call.arguments_sha256,
        capability_set_sha256,
        idempotency_key: format!("prepare:{}", operation_id(call)),
        deadline_at_unix_ms,
    }
}

pub(super) fn operation_id(call: &ProviderToolCall) -> String {
    // Provider tool IDs may repeat on another turn. Length-prefixing avoids
    // delimiter collisions while preserving the provider's original tool ID.
    let provider = call.operation_id.as_str();
    format!(
        "capability:{}:{provider}:{}",
        provider.len(),
        call.tool_use_id.as_str()
    )
}

#[derive(Debug)]
pub enum CapabilityPrepareError<G, A> {
    InvalidState,
    Authority(A),
    Gateway(G),
}

impl<G: Display, A: Display> Display for CapabilityPrepareError<G, A> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidState => formatter.write_str("capability prepare requires dispatch state"),
            Self::Authority(error) => write!(formatter, "capability authority failed: {error}"),
            Self::Gateway(error) => write!(formatter, "capability gateway failed: {error}"),
        }
    }
}

impl<G: Error + 'static, A: Error + 'static> Error for CapabilityPrepareError<G, A> {}
