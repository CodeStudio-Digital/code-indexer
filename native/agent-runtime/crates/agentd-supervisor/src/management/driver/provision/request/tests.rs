use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

use super::{ProtectedEndpointSeal, ProtectedLaunchRequest};
use crate::management::ProtectedLaunchPeerAuthority;

impl ProtectedLaunchRequest<'_> {
    pub(in crate::management::driver) fn with_endpoints_for_test<'b>(
        &'b self,
        endpoints: &'b [wire::ProtectedAttemptEndpoint],
    ) -> ProtectedLaunchRequest<'b> {
        ProtectedLaunchRequest {
            identity: self.identity.clone(),
            runtime_instance_id: self.runtime_instance_id,
            hard_deadline_at_unix_ms: self.hard_deadline_at_unix_ms,
            authority_lease_expires_at_unix_ms: self.authority_lease_expires_at_unix_ms,
            reserved_resource_budget: self.reserved_resource_budget,
            endpoints,
            launch_nonce: self.launch_nonce,
            activation_authority_seal: self.activation_authority_seal,
            expected_runner_provenance: self.expected_runner_provenance,
            payload_digest: self.payload_digest,
            peer_authority: self.peer_authority,
        }
    }

    pub(in crate::management::driver) fn with_peer_authority_for_test<'b>(
        &'b self,
        peer_authority: &'b ProtectedLaunchPeerAuthority,
    ) -> ProtectedLaunchRequest<'b> {
        ProtectedLaunchRequest {
            identity: self.identity.clone(),
            runtime_instance_id: self.runtime_instance_id,
            hard_deadline_at_unix_ms: self.hard_deadline_at_unix_ms,
            authority_lease_expires_at_unix_ms: self.authority_lease_expires_at_unix_ms,
            reserved_resource_budget: self.reserved_resource_budget,
            endpoints: self.endpoints,
            launch_nonce: self.launch_nonce,
            activation_authority_seal: self.activation_authority_seal,
            expected_runner_provenance: self.expected_runner_provenance,
            payload_digest: self.payload_digest,
            peer_authority,
        }
    }

    pub(in crate::management::driver) fn with_authority_lease_for_test(
        &self,
        authority_lease_expires_at_unix_ms: i64,
    ) -> ProtectedLaunchRequest<'_> {
        ProtectedLaunchRequest {
            identity: self.identity.clone(),
            runtime_instance_id: self.runtime_instance_id,
            hard_deadline_at_unix_ms: self.hard_deadline_at_unix_ms,
            authority_lease_expires_at_unix_ms,
            reserved_resource_budget: self.reserved_resource_budget,
            endpoints: self.endpoints,
            launch_nonce: self.launch_nonce,
            activation_authority_seal: self.activation_authority_seal,
            expected_runner_provenance: self.expected_runner_provenance,
            payload_digest: self.payload_digest,
            peer_authority: self.peer_authority,
        }
    }
}

#[test]
fn endpoint_seal_redacts_and_zeroizes_derived_sensitive_values() {
    let mut seal = ProtectedEndpointSeal::from_wire(&wire::ProtectedAttemptEndpoint {
        endpoint_id: "endpoint-sensitive".into(),
        address: "address-sensitive".into(),
        connection_id: "connection-sensitive".into(),
        connection_token: b"token-sensitive".to_vec(),
        ..wire::ProtectedAttemptEndpoint::default()
    });

    let debug = format!("{seal:?}");
    for sensitive in [
        "endpoint-sensitive",
        "address-sensitive",
        "connection-sensitive",
    ] {
        assert!(!debug.contains(sensitive));
    }

    seal.zeroize();
    assert!(seal.endpoint_id.is_empty());
    assert!(seal.address.is_empty());
    assert!(seal.connection_id.is_empty());
    assert_eq!(seal.connection_token_digest, [0; 32]);
}
