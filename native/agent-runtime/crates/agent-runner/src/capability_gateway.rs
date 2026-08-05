use std::future::Future;
use std::sync::Arc;

use agent_protocol::generated::v1 as wire;
use agent_tools::capability::{CapabilityDecision, CapabilityGatewayPort, CapabilityInvocation};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;

use crate::provider_data::{ProviderDataClient, ProviderDataClock, ProviderDataTiming};

mod error;
mod mapping;

pub use error::CapabilityGatewayError;
use mapping::{decision_from_wire, execution_class_to_wire};

#[derive(Debug)]
pub struct CapabilityDataGateway<S, C> {
    client: Arc<Mutex<ProviderDataClient<S>>>,
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    timing: ProviderDataTiming,
    clock: Arc<C>,
    capability_set_sha256: [u8; 32],
    maximum_input_bytes: usize,
}

impl<S, C> CapabilityDataGateway<S, C> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) const fn new(
        client: Arc<Mutex<ProviderDataClient<S>>>,
        identity: wire::AttemptIdentity,
        runtime_instance_id: String,
        timing: ProviderDataTiming,
        clock: Arc<C>,
        capability_set_sha256: [u8; 32],
        maximum_input_bytes: usize,
    ) -> Self {
        Self {
            client,
            identity,
            runtime_instance_id,
            timing,
            clock,
            capability_set_sha256,
            maximum_input_bytes,
        }
    }
}

impl<S, C> CapabilityDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    async fn prepare_inner(
        &self,
        invocation: CapabilityInvocation,
    ) -> Result<CapabilityDecision, CapabilityGatewayError> {
        invocation
            .validate(self.maximum_input_bytes)
            .map_err(CapabilityGatewayError::InvalidInvocation)?;
        if invocation.capability_set_sha256 != self.capability_set_sha256
            || Sha256::digest(&invocation.encoded_json_input).as_slice() != invocation.input_sha256
        {
            return Err(CapabilityGatewayError::AuthorityMismatch);
        }
        let prepare = wire::CapabilityPrepare {
            identity: Some(self.identity.clone()),
            runtime_instance_id: self.runtime_instance_id.clone(),
            operation_id: invocation.operation_id.clone(),
            provider_operation_id: invocation.provider_operation_id.clone(),
            tool_use_id: invocation.tool_use_id.clone(),
            capability_id: invocation.capability_id.clone(),
            capability_version: invocation.capability_version.clone(),
            execution_class: execution_class_to_wire(invocation.execution_class).into(),
            mutates: invocation.mutates,
            encoded_json_input: invocation.encoded_json_input.clone(),
            input_sha256: invocation.input_sha256.to_vec(),
            capability_set_sha256: invocation.capability_set_sha256.to_vec(),
            idempotency_key: invocation.idempotency_key.clone(),
            deadline_at_unix_ms: invocation.deadline_at_unix_ms,
        };
        let update = self
            .client
            .lock()
            .await
            .prepare_capability(prepare, self.timing, self.clock.as_ref())
            .await
            .map_err(CapabilityGatewayError::Data)?;
        decision_from_wire(update, &invocation)
    }
}

impl<S, C> CapabilityGatewayPort for CapabilityDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    type Error = CapabilityGatewayError;

    fn prepare(
        &mut self,
        invocation: CapabilityInvocation,
    ) -> impl Future<Output = Result<CapabilityDecision, Self::Error>> + Send {
        self.prepare_inner(invocation)
    }
}
