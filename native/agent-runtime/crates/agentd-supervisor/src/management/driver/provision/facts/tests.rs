use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

use super::ProtectedLaunchHandoffFacts;
use crate::management::ProtectedLaunchPeerAuthority;

#[test]
fn canonical_owner_redacts_and_zeroizes_all_secret_bearing_buffers() {
    let mut facts = ProtectedLaunchHandoffFacts {
        identity: wire::AttemptIdentity {
            session_id: "session-sensitive".into(),
            ..wire::AttemptIdentity::default()
        },
        runtime_instance_id: "runtime-sensitive".into(),
        hard_deadline_at_unix_ms: 10,
        authority_lease_expires_at_unix_ms: 9,
        reserved_resource_budget: wire::ResourceBudget::default(),
        endpoints: vec![wire::ProtectedAttemptEndpoint {
            endpoint_id: "endpoint-sensitive".into(),
            address: "address-sensitive".into(),
            connection_id: "connection-sensitive".into(),
            connection_token: b"token-sensitive".to_vec(),
            ..wire::ProtectedAttemptEndpoint::default()
        }],
        launch_nonce: b"nonce-sensitive".to_vec(),
        activation_authority_seal: wire::ActivationAuthoritySeal {
            agent_run_version: 8,
            attempt_version: 5,
            activation_nonce_sha256: vec![4; 32],
        },
        expected_runner_provenance: wire::ExpectedRuntimeProvenance {
            build_id: "build-sensitive".into(),
            source_commit: "commit-sensitive".into(),
            binary_sha256: vec![8; 32],
            operating_system: "system-sensitive".into(),
            architecture: "architecture-sensitive".into(),
        },
        launch_management_payload_sha256: [9; 32],
        peer_authority: authority(),
    };

    let debug = format!("{facts:?}");
    for secret in [
        "runtime-sensitive",
        "endpoint-sensitive",
        "address-sensitive",
        "connection-sensitive",
        "token-sensitive",
        "nonce-sensitive",
        "build-sensitive",
        "commit-sensitive",
        "system-sensitive",
        "architecture-sensitive",
    ] {
        assert!(!debug.contains(secret));
    }
    assert!(debug.contains("[REDACTED]"));

    facts.zeroize();
    assert!(facts.identity().session_id.is_empty());
    assert!(facts.runtime_instance_id().is_empty());
    assert!(facts.endpoints()[0].endpoint_id.is_empty());
    assert!(facts.endpoints()[0].address.is_empty());
    assert!(facts.endpoints()[0].connection_id.is_empty());
    assert!(facts.endpoints()[0].connection_token.is_empty());
    assert!(facts.launch_nonce().is_empty());
    assert!(
        facts
            .activation_authority_seal()
            .activation_nonce_sha256
            .iter()
            .all(|byte| *byte == 0)
    );
    let provenance = facts.runtime_provenance(42);
    assert!(provenance.build_id.is_empty());
    assert!(provenance.source_commit.is_empty());
    assert!(provenance.binary_sha256.iter().all(|byte| *byte == 0));
    assert!(provenance.operating_system.is_empty());
    assert!(provenance.architecture.is_empty());
    assert_eq!(facts.launch_management_payload_sha256(), &[0; 32]);
}

fn authority() -> ProtectedLaunchPeerAuthority {
    let supervisor_process_id = std::process::id();
    let host_process_id = (1..=u32::MAX)
        .find(|candidate| *candidate != supervisor_process_id)
        .expect("one excluded process ID leaves a valid host PID");
    #[cfg(windows)]
    let unix_ids = (None, None);
    #[cfg(unix)]
    let unix_ids = (Some(1_000), Some(1_000));
    ProtectedLaunchPeerAuthority::new_for_test(
        host_process_id,
        supervisor_process_id,
        unix_ids.0,
        unix_ids.1,
    )
    .expect("valid physical peers")
}
