use super::{
    AsyncRead, AsyncWrite, CapabilityDataGateway, CapabilityExecutionOutcome,
    CapabilityGatewayError, CapabilityInvocation, Digest, ExecutionClass, ProviderDataClock,
    SealedExecutionGrant, Sha256, outcome_from_wire, wire,
};
use agent_tools::capability::CapabilityReadBatchPort;

impl<S, C> CapabilityReadBatchPort for CapabilityDataGateway<S, C>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
    C: ProviderDataClock,
{
    async fn start_read_batch(
        &mut self,
        members: &[(CapabilityInvocation, SealedExecutionGrant)],
    ) -> Result<(), Self::Error> {
        if !self.read_members.is_empty() || !(2..=4).contains(&members.len()) {
            return Err(CapabilityGatewayError::AuthorityMismatch);
        }
        let mut executions = Vec::with_capacity(members.len());
        for (invocation, grant) in members {
            invocation
                .validate(self.maximum_input_bytes)
                .map_err(CapabilityGatewayError::InvalidInvocation)?;
            if invocation.execution_class != ExecutionClass::HostCapability
                || invocation.mutates
                || grant.mutates
                || grant.execution_class != ExecutionClass::HostCapability
                || invocation.capability_set_sha256 != self.capability_set_sha256
                || Sha256::digest(&invocation.encoded_json_input).as_slice()
                    != invocation.input_sha256
            {
                return Err(CapabilityGatewayError::AuthorityMismatch);
            }
            executions.push(wire::CapabilityExecute {
                identity: Some(self.identity.clone()),
                runtime_instance_id: self.runtime_instance_id.clone(),
                operation_id: invocation.operation_id.clone(),
                tool_use_id: invocation.tool_use_id.clone(),
                grant_id: grant.grant_id.clone(),
                effective_input_sha256: invocation.input_sha256.to_vec(),
                deadline_at_unix_ms: invocation.deadline_at_unix_ms,
            });
        }
        self.client
            .lock()
            .await
            .start_read_batch(
                wire::CapabilityReadBatchExecute {
                    identity: Some(self.identity.clone()),
                    runtime_instance_id: self.runtime_instance_id.clone(),
                    batch_id: format!("reads:{}", members[0].0.operation_id),
                    members: executions,
                },
                self.timing,
                self.clock.as_ref(),
            )
            .await
            .map_err(CapabilityGatewayError::Data)?;
        self.read_members = members.to_vec();
        Ok(())
    }

    async fn next_read_result(
        &mut self,
    ) -> Result<(String, CapabilityExecutionOutcome), Self::Error> {
        let result = self
            .client
            .lock()
            .await
            .next_read_result(self.timing, self.clock.as_ref())
            .await
            .map_err(CapabilityGatewayError::Data)?;
        let index = self
            .read_members
            .iter()
            .position(|(invocation, _)| invocation.operation_id == result.operation_id)
            .ok_or(CapabilityGatewayError::AuthorityMismatch)?;
        let (invocation, grant) = self.read_members.remove(index);
        let outcome = outcome_from_wire(result, &invocation, &grant, self.maximum_input_bytes)?;
        Ok((invocation.operation_id, outcome))
    }
}
