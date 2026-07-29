use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;
use agent_protocol::semantic_hash::semantic_sha256;
use agent_protocol::wire_identity::identity_to_wire;
use zeroize::Zeroize;

use super::peer::ProtectedLaunchPeerAuthority;
use super::request::{ProtectedEndpointSeal, ProtectedLaunchRequest};
use super::scrub::zeroize_identity;
use crate::management::driver::plan::LaunchPlan;

#[derive(Clone, PartialEq, Eq)]
pub(super) struct ProtectedLaunchSeal {
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    hard_deadline_at_unix_ms: i64,
    authority_lease_expires_at_unix_ms: i64,
    reserved_resource_budget: wire::ResourceBudget,
    endpoints: Vec<ProtectedEndpointSeal>,
    launch_nonce_digest: [u8; 32],
    payload_digest: [u8; 32],
    peer_authority: ProtectedLaunchPeerAuthority,
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows seal minting is internal; other platforms remain gated"
    )
)]
impl ProtectedLaunchSeal {
    pub(super) fn from_request(request: &ProtectedLaunchRequest<'_>) -> Self {
        let launch_nonce_digest =
            semantic_sha256("codestudio.agent.launch-nonce", 1, request.launch_nonce())
                .expect("validated launch nonce hashes");
        Self {
            identity: request.identity().clone(),
            runtime_instance_id: request.runtime_instance_id().to_owned(),
            hard_deadline_at_unix_ms: request.hard_deadline_at_unix_ms(),
            authority_lease_expires_at_unix_ms: request.authority_lease_expires_at_unix_ms(),
            reserved_resource_budget: request.reserved_resource_budget(),
            endpoints: request.endpoint_seals(),
            launch_nonce_digest,
            payload_digest: *request.payload_digest(),
            peer_authority: request.peer_authority().clone(),
        }
    }

    pub(super) fn matches(
        &self,
        plan: &LaunchPlan,
        peer_authority: &ProtectedLaunchPeerAuthority,
    ) -> bool {
        self.identity == identity_to_wire(plan.identity())
            && self.runtime_instance_id == plan.runtime_instance_id()
            && self.hard_deadline_at_unix_ms == plan.hard_deadline_at_unix_ms()
            && self.authority_lease_expires_at_unix_ms == plan.authority_lease_expires_at_unix_ms()
            && self.reserved_resource_budget == plan.budget_wire()
            && self.endpoints == plan.endpoint_seals()
            && self.launch_nonce_digest == *plan.launch_nonce_digest()
            && self.payload_digest == *plan.payload_digest()
            && self.peer_authority == *peer_authority
    }
}

impl Debug for ProtectedLaunchSeal {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedLaunchSeal")
            .field("identity", &"[REDACTED]")
            .field("runtime_instance_id", &"[REDACTED]")
            .field("hard_deadline_at_unix_ms", &self.hard_deadline_at_unix_ms)
            .field(
                "authority_lease_expires_at_unix_ms",
                &self.authority_lease_expires_at_unix_ms,
            )
            .field("reserved_resource_budget", &self.reserved_resource_budget)
            .field("endpoints", &self.endpoints)
            .field("launch_nonce_digest", &"[REDACTED]")
            .field("payload_digest", &"[REDACTED]")
            .field("peer_authority", &self.peer_authority)
            .finish()
    }
}

impl Zeroize for ProtectedLaunchSeal {
    fn zeroize(&mut self) {
        zeroize_identity(&mut self.identity);
        self.runtime_instance_id.zeroize();
        for endpoint in &mut self.endpoints {
            endpoint.zeroize();
        }
        self.endpoints.clear();
        self.launch_nonce_digest.zeroize();
        self.payload_digest.zeroize();
    }
}

impl Drop for ProtectedLaunchSeal {
    fn drop(&mut self) {
        self.zeroize();
    }
}

#[cfg(test)]
mod tests;
