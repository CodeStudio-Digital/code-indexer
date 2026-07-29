use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;
use agent_protocol::semantic_hash::semantic_sha256;
use agent_protocol::wire_identity::identity_to_wire;
use zeroize::Zeroize;

use super::peer::ProtectedLaunchPeerAuthority;
use super::scrub::zeroize_identity;
use crate::management::driver::plan::LaunchPlan;

#[derive(Clone, PartialEq, Eq)]
pub(in crate::management::driver) struct ProtectedEndpointSeal {
    kind: i32,
    endpoint_id: String,
    address: String,
    connection_id: String,
    connection_token_digest: [u8; 32],
    max_frame_bytes: u64,
}

impl ProtectedEndpointSeal {
    pub(in crate::management::driver) fn from_wire(
        endpoint: &wire::ProtectedAttemptEndpoint,
    ) -> Self {
        let connection_token_digest = semantic_sha256(
            "codestudio.agent.protected-endpoint-token",
            1,
            &endpoint.connection_token,
        )
        .expect("fixed endpoint-token hash schema is valid");
        Self {
            kind: endpoint.kind,
            endpoint_id: endpoint.endpoint_id.clone(),
            address: endpoint.address.clone(),
            connection_id: endpoint.connection_id.clone(),
            connection_token_digest,
            max_frame_bytes: endpoint.max_frame_bytes,
        }
    }
}

impl Debug for ProtectedEndpointSeal {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedEndpointSeal")
            .field("kind", &self.kind)
            .field("endpoint_id", &"[REDACTED]")
            .field("address", &"[REDACTED]")
            .field("connection_id", &"[REDACTED]")
            .field("connection_token_digest", &"[REDACTED]")
            .field("max_frame_bytes", &self.max_frame_bytes)
            .finish()
    }
}

impl Zeroize for ProtectedEndpointSeal {
    fn zeroize(&mut self) {
        self.endpoint_id.zeroize();
        self.address.zeroize();
        self.connection_id.zeroize();
        self.connection_token_digest.zeroize();
    }
}

impl Drop for ProtectedEndpointSeal {
    fn drop(&mut self) {
        self.zeroize();
    }
}

/// Narrow secret-bearing request for a trusted OS endpoint provisioner.
///
/// It is never converted into process arguments or environment variables.
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes handoff inputs; other platform provisioners remain gated"
    )
)]
pub struct ProtectedLaunchRequest<'a> {
    identity: wire::AttemptIdentity,
    runtime_instance_id: &'a str,
    hard_deadline_at_unix_ms: i64,
    authority_lease_expires_at_unix_ms: i64,
    reserved_resource_budget: wire::ResourceBudget,
    endpoints: &'a [wire::ProtectedAttemptEndpoint],
    launch_nonce: &'a [u8],
    activation_authority_seal: &'a wire::ActivationAuthoritySeal,
    expected_runner_provenance: &'a wire::ExpectedRuntimeProvenance,
    payload_digest: [u8; 32],
    peer_authority: &'a ProtectedLaunchPeerAuthority,
}

impl Debug for ProtectedLaunchRequest<'_> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedLaunchRequest")
            .field("identity", &"[REDACTED]")
            .field("runtime_instance_id", &"[REDACTED]")
            .field("hard_deadline_at_unix_ms", &self.hard_deadline_at_unix_ms)
            .field(
                "authority_lease_expires_at_unix_ms",
                &self.authority_lease_expires_at_unix_ms,
            )
            .field("reserved_resource_budget", &self.reserved_resource_budget)
            .field("endpoint_count", &self.endpoints.len())
            .field("endpoint_secrets", &"[REDACTED]")
            .field("launch_nonce", &"[REDACTED]")
            .field("activation_authority_seal", &"[COMMITMENT]")
            .field("expected_runner_provenance", &"[TRUSTED; REDACTED]")
            .field("payload_digest", &"[REDACTED]")
            .field("peer_authority", &self.peer_authority)
            .finish()
    }
}

impl Zeroize for ProtectedLaunchRequest<'_> {
    fn zeroize(&mut self) {
        zeroize_identity(&mut self.identity);
        self.payload_digest.zeroize();
    }
}

impl Drop for ProtectedLaunchRequest<'_> {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[cfg(test)]
mod tests;

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes handoff inputs; other platform provisioners remain gated"
    )
)]
impl<'a> ProtectedLaunchRequest<'a> {
    pub(in crate::management::driver) fn new(
        launch: &'a wire::LaunchAttemptProcess,
        plan: &'a LaunchPlan,
        peer_authority: &'a ProtectedLaunchPeerAuthority,
    ) -> Self {
        Self {
            identity: identity_to_wire(plan.identity()),
            runtime_instance_id: plan.runtime_instance_id(),
            hard_deadline_at_unix_ms: plan.hard_deadline_at_unix_ms(),
            authority_lease_expires_at_unix_ms: plan.authority_lease_expires_at_unix_ms(),
            reserved_resource_budget: plan.budget_wire(),
            endpoints: &launch.protected_endpoints,
            launch_nonce: &launch.launch_nonce,
            activation_authority_seal: launch
                .activation_authority_seal
                .as_ref()
                .expect("management channel validated activation authority"),
            expected_runner_provenance: plan.expected_runner_provenance(),
            payload_digest: *plan.payload_digest(),
            peer_authority,
        }
    }

    #[must_use]
    pub(in crate::management::driver) const fn identity(&self) -> &wire::AttemptIdentity {
        &self.identity
    }

    #[must_use]
    pub(in crate::management::driver) const fn runtime_instance_id(&self) -> &str {
        self.runtime_instance_id
    }

    #[must_use]
    pub(in crate::management::driver) const fn hard_deadline_at_unix_ms(&self) -> i64 {
        self.hard_deadline_at_unix_ms
    }

    #[must_use]
    pub(in crate::management::driver) const fn authority_lease_expires_at_unix_ms(&self) -> i64 {
        self.authority_lease_expires_at_unix_ms
    }

    #[must_use]
    pub(in crate::management::driver) const fn reserved_resource_budget(
        &self,
    ) -> wire::ResourceBudget {
        self.reserved_resource_budget
    }

    #[must_use]
    pub(in crate::management::driver) const fn endpoints(
        &self,
    ) -> &[wire::ProtectedAttemptEndpoint] {
        self.endpoints
    }

    #[must_use]
    pub(in crate::management::driver) const fn launch_nonce(&self) -> &[u8] {
        self.launch_nonce
    }

    #[must_use]
    pub(in crate::management::driver) const fn activation_authority_seal(
        &self,
    ) -> &wire::ActivationAuthoritySeal {
        self.activation_authority_seal
    }

    #[must_use]
    pub(in crate::management::driver) const fn expected_runner_provenance(
        &self,
    ) -> &wire::ExpectedRuntimeProvenance {
        self.expected_runner_provenance
    }

    #[must_use]
    pub(in crate::management::driver) const fn payload_digest(&self) -> &[u8; 32] {
        &self.payload_digest
    }

    #[must_use]
    pub(in crate::management::driver) const fn peer_authority(
        &self,
    ) -> &ProtectedLaunchPeerAuthority {
        self.peer_authority
    }

    pub(super) fn endpoint_seals(&self) -> Vec<ProtectedEndpointSeal> {
        self.endpoints
            .iter()
            .map(ProtectedEndpointSeal::from_wire)
            .collect()
    }
}
