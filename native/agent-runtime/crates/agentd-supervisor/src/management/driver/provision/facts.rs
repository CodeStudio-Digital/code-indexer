use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

use super::peer::ProtectedLaunchPeerAuthority;
use super::pulse::ProtectedRunnerPulseAuthority;
use super::request::ProtectedLaunchRequest;
use super::scrub::zeroize_identity;

/// Canonical, single-owner immutable inputs for one runner handoff.
///
/// The provisioner should borrow these values and must not duplicate secrets
/// into its provider-specific pending state.
#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes these inputs; other platform provisioners remain gated"
    )
)]
pub(in crate::management::driver) struct ProtectedLaunchHandoffFacts {
    identity: wire::AttemptIdentity,
    runtime_instance_id: String,
    hard_deadline_at_unix_ms: i64,
    authority_lease_expires_at_unix_ms: i64,
    runner_pulse_interval_ms: u64,
    reserved_resource_budget: wire::ResourceBudget,
    endpoints: Vec<wire::ProtectedAttemptEndpoint>,
    launch_nonce: Vec<u8>,
    activation_authority_seal: wire::ActivationAuthoritySeal,
    expected_runner_provenance: wire::ExpectedRuntimeProvenance,
    launch_management_payload_sha256: [u8; 32],
    peer_authority: ProtectedLaunchPeerAuthority,
}

#[cfg_attr(
    not(test),
    allow(
        dead_code,
        reason = "Windows consumes these inputs; other platform provisioners remain gated"
    )
)]
impl ProtectedLaunchHandoffFacts {
    pub(super) fn from_request(request: &ProtectedLaunchRequest<'_>) -> Self {
        Self {
            identity: request.identity().clone(),
            runtime_instance_id: request.runtime_instance_id().to_owned(),
            hard_deadline_at_unix_ms: request.hard_deadline_at_unix_ms(),
            authority_lease_expires_at_unix_ms: request.authority_lease_expires_at_unix_ms(),
            runner_pulse_interval_ms: request.runner_pulse_interval_ms(),
            reserved_resource_budget: request.reserved_resource_budget(),
            endpoints: request.endpoints().to_vec(),
            launch_nonce: request.launch_nonce().to_vec(),
            activation_authority_seal: request.activation_authority_seal().clone(),
            expected_runner_provenance: request.expected_runner_provenance().clone(),
            launch_management_payload_sha256: *request.payload_digest(),
            peer_authority: request.peer_authority().clone(),
        }
    }

    #[must_use]
    pub(in crate::management::driver) const fn identity(&self) -> &wire::AttemptIdentity {
        &self.identity
    }

    #[must_use]
    pub(in crate::management::driver) fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
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
    pub(in crate::management::driver) const fn runner_pulse_interval_ms(&self) -> u64 {
        self.runner_pulse_interval_ms
    }

    #[must_use]
    pub(in crate::management::driver) const fn reserved_resource_budget(
        &self,
    ) -> wire::ResourceBudget {
        self.reserved_resource_budget
    }

    #[must_use]
    pub(in crate::management::driver) fn endpoints(&self) -> &[wire::ProtectedAttemptEndpoint] {
        &self.endpoints
    }

    #[must_use]
    pub(in crate::management::driver) fn launch_nonce(&self) -> &[u8] {
        &self.launch_nonce
    }

    #[must_use]
    pub(in crate::management::driver) const fn activation_authority_seal(
        &self,
    ) -> &wire::ActivationAuthoritySeal {
        &self.activation_authority_seal
    }

    #[must_use]
    pub(in crate::management::driver) fn runtime_provenance(
        &self,
        process_id: u32,
    ) -> wire::RuntimeProvenance {
        wire::RuntimeProvenance {
            build_id: self.expected_runner_provenance.build_id.clone(),
            source_commit: self.expected_runner_provenance.source_commit.clone(),
            binary_sha256: self.expected_runner_provenance.binary_sha256.clone(),
            runtime_instance_id: self.runtime_instance_id.clone(),
            pid: process_id,
            operating_system: self.expected_runner_provenance.operating_system.clone(),
            architecture: self.expected_runner_provenance.architecture.clone(),
        }
    }

    #[must_use]
    pub(in crate::management::driver) const fn launch_management_payload_sha256(
        &self,
    ) -> &[u8; 32] {
        &self.launch_management_payload_sha256
    }

    #[must_use]
    pub(in crate::management::driver) const fn peer_authority(
        &self,
    ) -> &ProtectedLaunchPeerAuthority {
        &self.peer_authority
    }

    pub(in crate::management::driver) fn take_runner_pulse_authority(
        &mut self,
    ) -> Option<
        Result<ProtectedRunnerPulseAuthority, agent_protocol::pulse_channel::RunnerPulseError>,
    > {
        let endpoint = self
            .endpoints
            .iter_mut()
            .find(|endpoint| endpoint.kind == wire::AttemptEndpointKind::RunnerPulse as i32)?;
        let token = std::mem::take(&mut endpoint.connection_token);
        Some(ProtectedRunnerPulseAuthority::new(
            self.identity.clone(),
            self.runtime_instance_id.clone(),
            endpoint.address.clone(),
            &endpoint.connection_id,
            token,
        ))
    }
}

impl Zeroize for ProtectedLaunchHandoffFacts {
    fn zeroize(&mut self) {
        zeroize_identity(&mut self.identity);
        self.runtime_instance_id.zeroize();
        for endpoint in &mut self.endpoints {
            endpoint.endpoint_id.zeroize();
            endpoint.address.zeroize();
            endpoint.connection_id.zeroize();
            endpoint.connection_token.zeroize();
        }
        self.launch_nonce.zeroize();
        self.activation_authority_seal
            .activation_nonce_sha256
            .zeroize();
        self.expected_runner_provenance.build_id.zeroize();
        self.expected_runner_provenance.source_commit.zeroize();
        self.expected_runner_provenance.binary_sha256.zeroize();
        self.expected_runner_provenance.operating_system.zeroize();
        self.expected_runner_provenance.architecture.zeroize();
        self.launch_management_payload_sha256.zeroize();
    }
}

impl Drop for ProtectedLaunchHandoffFacts {
    fn drop(&mut self) {
        self.zeroize();
    }
}

impl Debug for ProtectedLaunchHandoffFacts {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProtectedLaunchHandoffFacts")
            .field("identity", &"[REDACTED]")
            .field("runtime_instance_id", &"[REDACTED]")
            .field("hard_deadline_at_unix_ms", &self.hard_deadline_at_unix_ms)
            .field(
                "authority_lease_expires_at_unix_ms",
                &self.authority_lease_expires_at_unix_ms,
            )
            .field("runner_pulse_interval_ms", &self.runner_pulse_interval_ms)
            .field("reserved_resource_budget", &self.reserved_resource_budget)
            .field("endpoint_count", &self.endpoints.len())
            .field("endpoint_secrets", &"[REDACTED]")
            .field("launch_nonce", &"[REDACTED]")
            .field("activation_authority_seal", &"[COMMITMENT]")
            .field("expected_runner_provenance", &"[TRUSTED; REDACTED]")
            .field("launch_management_payload_sha256", &"[REDACTED]")
            .field("peer_authority", &self.peer_authority)
            .finish()
    }
}

#[cfg(test)]
mod tests;
