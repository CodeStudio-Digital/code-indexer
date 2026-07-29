use std::fmt::{self, Formatter};

use agent_protocol::activation_authority::ActivationAuthoritySeal;
#[cfg(test)]
use agent_protocol::bootstrap_limits::{
    BOOTSTRAP_SECRET_MIN_BYTES, LAUNCH_NONCE_MAX_BYTES, SESSION_TOKEN_MAX_BYTES,
};
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::{AttemptIdentity, ConnectionId, RuntimeInstanceId};
use agent_protocol::runner_bootstrap::RunnerEndpointTokenVerifier;
#[cfg(test)]
use agent_protocol::semantic_hash::semantic_sha256;
use agent_protocol::wire_identity::identity_from_wire;
#[cfg(test)]
use agent_protocol::wire_identity::identity_to_wire;

use super::effective::validate_budget_reason;

mod error;
mod handoff;
mod validation;

pub use error::LaunchContextError;
#[cfg(test)]
use validation::constant_time_equal;
use validation::{
    validate_expected_connection_id, validate_level, validate_limits, validate_runtime_id,
};

#[cfg(test)]
const CONNECTION_TOKEN_SCHEMA_ID: &str = "codestudio.agent.v1.ConnectionSessionToken";

/// Single-use authority delivered by the trusted process bootstrap.
///
/// This type is intentionally not cloneable. Moving it into one
/// [`super::RunnerControlSession`] consumes the bootstrap authority.
pub struct RunnerLaunchContext {
    identity: AttemptIdentity,
    wire_identity: wire::AttemptIdentity,
    runtime_instance_id: RuntimeInstanceId,
    expected_connection_id: ConnectionId,
    connection_token_authority: ConnectionTokenAuthority,
    activation_authority_seal: ActivationAuthoritySeal,
    hard_deadline_at_unix_ms: i64,
    resource_budget: wire::ResourceBudget,
    required_containment_level: wire::ContainmentLevel,
    required_enforced_limits: Vec<wire::ResourceLimitKind>,
}

enum ConnectionTokenAuthority {
    Handoff(RunnerEndpointTokenVerifier),
    #[cfg(test)]
    Digest([u8; 32]),
}

impl fmt::Debug for RunnerLaunchContext {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerLaunchContext")
            .field("identity", &self.identity)
            .field("runtime_instance_id", &self.runtime_instance_id)
            .field("expected_connection_id", &self.expected_connection_id)
            .field("launch_nonce", &"[REDACTED]")
            .field("connection_session_token", &"[REDACTED]")
            .field("activation_authority_seal", &"[COMMITMENT]")
            .field("hard_deadline_at_unix_ms", &self.hard_deadline_at_unix_ms)
            .field("resource_budget", &self.resource_budget)
            .field(
                "required_containment_level",
                &self.required_containment_level,
            )
            .field("required_enforced_limits", &self.required_enforced_limits)
            .finish_non_exhaustive()
    }
}

impl RunnerLaunchContext {
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)]
    pub(in crate::control) fn new(
        identity: AttemptIdentity,
        runtime_instance_id: RuntimeInstanceId,
        expected_connection_id: ConnectionId,
        launch_nonce: &[u8],
        connection_session_token: &[u8],
        activation_authority_seal: &wire::ActivationAuthoritySeal,
        hard_deadline_at_unix_ms: i64,
        resource_budget: wire::ResourceBudget,
        required_containment_level: wire::ContainmentLevel,
        required_enforced_limits: Vec<wire::ResourceLimitKind>,
    ) -> Result<Self, LaunchContextError> {
        if !(BOOTSTRAP_SECRET_MIN_BYTES..=LAUNCH_NONCE_MAX_BYTES).contains(&launch_nonce.len()) {
            return Err(LaunchContextError::InvalidLaunchNonce);
        }
        if !(BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES)
            .contains(&connection_session_token.len())
        {
            return Err(LaunchContextError::InvalidConnectionSessionToken);
        }
        let connection_session_token_sha256 =
            semantic_sha256(CONNECTION_TOKEN_SCHEMA_ID, 1, connection_session_token)
                .map_err(LaunchContextError::SemanticHash)?;
        let wire_identity = identity_to_wire(&identity);
        let activation_authority_seal =
            ActivationAuthoritySeal::try_from(activation_authority_seal)
                .map_err(LaunchContextError::InvalidActivationAuthoritySeal)?;

        Self::build(
            identity,
            wire_identity,
            runtime_instance_id,
            expected_connection_id,
            ConnectionTokenAuthority::Digest(connection_session_token_sha256),
            activation_authority_seal,
            hard_deadline_at_unix_ms,
            resource_budget,
            required_containment_level,
            required_enforced_limits,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn build(
        identity: AttemptIdentity,
        wire_identity: wire::AttemptIdentity,
        runtime_instance_id: RuntimeInstanceId,
        expected_connection_id: ConnectionId,
        connection_token_authority: ConnectionTokenAuthority,
        activation_authority_seal: ActivationAuthoritySeal,
        hard_deadline_at_unix_ms: i64,
        resource_budget: wire::ResourceBudget,
        required_containment_level: wire::ContainmentLevel,
        required_enforced_limits: Vec<wire::ResourceLimitKind>,
    ) -> Result<Self, LaunchContextError> {
        identity_from_wire(&wire_identity).map_err(LaunchContextError::InvalidIdentity)?;
        if identity.fencing_epoch == 0 {
            return Err(LaunchContextError::ZeroFencingEpoch);
        }
        validate_runtime_id(runtime_instance_id.as_str())?;
        validate_expected_connection_id(expected_connection_id.as_str())?;
        if hard_deadline_at_unix_ms <= 0 {
            return Err(LaunchContextError::InvalidHardDeadline(
                hard_deadline_at_unix_ms,
            ));
        }
        validate_budget_reason(&resource_budget)
            .map_err(LaunchContextError::InvalidResourceBudget)?;
        validate_level(required_containment_level)?;
        validate_limits(&required_enforced_limits)?;
        Ok(Self {
            identity,
            wire_identity,
            runtime_instance_id,
            expected_connection_id,
            connection_token_authority,
            activation_authority_seal,
            hard_deadline_at_unix_ms,
            resource_budget,
            required_containment_level,
            required_enforced_limits,
        })
    }

    #[must_use]
    pub const fn identity(&self) -> &AttemptIdentity {
        &self.identity
    }

    #[must_use]
    pub const fn runtime_instance_id(&self) -> &RuntimeInstanceId {
        &self.runtime_instance_id
    }

    #[must_use]
    pub const fn expected_connection_id(&self) -> &ConnectionId {
        &self.expected_connection_id
    }

    #[must_use]
    pub const fn hard_deadline_at_unix_ms(&self) -> i64 {
        self.hard_deadline_at_unix_ms
    }

    #[must_use]
    pub const fn resource_budget(&self) -> &wire::ResourceBudget {
        &self.resource_budget
    }

    #[must_use]
    pub const fn required_containment_level(&self) -> wire::ContainmentLevel {
        self.required_containment_level
    }

    #[must_use]
    pub fn required_enforced_limits(&self) -> &[wire::ResourceLimitKind] {
        &self.required_enforced_limits
    }

    pub(super) const fn wire_identity(&self) -> &wire::AttemptIdentity {
        &self.wire_identity
    }

    pub(super) const fn activation_authority_seal(&self) -> ActivationAuthoritySeal {
        self.activation_authority_seal
    }

    pub(super) fn connection_session_token_matches(&self, connection_session_token: &[u8]) -> bool {
        match &self.connection_token_authority {
            ConnectionTokenAuthority::Handoff(authority) => {
                authority.matches(connection_session_token)
            }
            #[cfg(test)]
            ConnectionTokenAuthority::Digest(expected) => {
                semantic_sha256(CONNECTION_TOKEN_SCHEMA_ID, 1, connection_session_token)
                    .is_ok_and(|actual| constant_time_equal(expected, &actual))
            }
        }
    }
}
