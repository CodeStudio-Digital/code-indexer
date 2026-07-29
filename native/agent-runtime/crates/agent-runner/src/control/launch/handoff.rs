use agent_protocol::activation_authority::ActivationAuthoritySeal;
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::{ConnectionId, RuntimeInstanceId};
use agent_protocol::runner_bootstrap::{
    RunnerEndpointTokenVerifier, ShapeValidatedRunnerLaunchHandoff,
};
use agent_protocol::wire_identity::identity_from_wire;

use super::{ConnectionTokenAuthority, LaunchContextError, RunnerLaunchContext};

impl RunnerLaunchContext {
    /// Derives control authority only from a shape-validated protected handoff.
    ///
    /// # Errors
    ///
    /// Rejects missing canonical fields or a verifier from another endpoint.
    pub(crate) fn from_validated_handoff(
        handoff: &ShapeValidatedRunnerLaunchHandoff,
        connection_token_authority: RunnerEndpointTokenVerifier,
    ) -> Result<Self, LaunchContextError> {
        let metadata = handoff.metadata();
        let wire_identity = metadata
            .identity
            .clone()
            .ok_or(LaunchContextError::InvalidHandoff("identity"))?;
        let identity =
            identity_from_wire(&wire_identity).map_err(LaunchContextError::InvalidIdentity)?;
        let runtime_instance_id = RuntimeInstanceId::new(metadata.runtime_instance_id.clone())
            .map_err(|_| LaunchContextError::InvalidRuntimeInstanceId)?;
        let control = metadata
            .endpoints
            .iter()
            .find(|endpoint| endpoint.kind == wire::AttemptEndpointKind::Control as i32)
            .ok_or(LaunchContextError::InvalidHandoff("control_endpoint"))?;
        let expected_connection_id = ConnectionId::new(control.connection_id.clone())
            .map_err(|_| LaunchContextError::InvalidExpectedConnectionId)?;
        if !connection_token_authority.is_bound_to(
            handoff.original_frame_sha256(),
            wire::AttemptEndpointKind::Control,
            expected_connection_id.as_str(),
        ) {
            return Err(LaunchContextError::EndpointAuthorityMismatch);
        }
        let resource_budget = metadata
            .reserved_resource_budget
            .ok_or(LaunchContextError::InvalidHandoff("resource_budget"))?;
        let containment = metadata
            .effective_containment
            .as_ref()
            .ok_or(LaunchContextError::InvalidHandoff("effective_containment"))?;
        let required_containment_level = wire::ContainmentLevel::try_from(containment.level)
            .map_err(|_| LaunchContextError::InvalidContainmentLevel)?;
        let required_enforced_limits = containment
            .enforced_limits
            .iter()
            .map(|limit| {
                wire::ResourceLimitKind::try_from(*limit)
                    .map_err(|_| LaunchContextError::InvalidRequiredLimit)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let activation_authority_seal = metadata
            .activation_authority_seal
            .as_ref()
            .ok_or(LaunchContextError::InvalidHandoff(
                "activation_authority_seal",
            ))
            .and_then(|seal| {
                ActivationAuthoritySeal::try_from(seal)
                    .map_err(LaunchContextError::InvalidActivationAuthoritySeal)
            })?;
        Self::build(
            identity,
            wire_identity,
            runtime_instance_id,
            expected_connection_id,
            ConnectionTokenAuthority::Handoff(connection_token_authority),
            activation_authority_seal,
            metadata.hard_deadline_at_unix_ms,
            resource_budget,
            required_containment_level,
            required_enforced_limits,
        )
    }
}
