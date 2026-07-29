use agent_protocol::generated::v1 as wire;
use zeroize::Zeroize;

use super::ProtectedLaunchSeal;
use crate::management::driver::provision::{ProtectedEndpointSeal, ProtectedLaunchPeerAuthority};

#[test]
fn launch_seal_redacts_and_zeroizes_owned_identifiers_and_digests() {
    let mut seal = ProtectedLaunchSeal {
        identity: wire::AttemptIdentity {
            session_id: "session-sensitive".into(),
            command_id: "command-sensitive".into(),
            owner_agent_run_id: Some("owner-sensitive".into()),
            ..wire::AttemptIdentity::default()
        },
        runtime_instance_id: "runtime-sensitive".into(),
        hard_deadline_at_unix_ms: 10,
        authority_lease_expires_at_unix_ms: 9,
        reserved_resource_budget: wire::ResourceBudget::default(),
        endpoints: vec![ProtectedEndpointSeal::from_wire(
            &wire::ProtectedAttemptEndpoint {
                address: "address-sensitive".into(),
                connection_token: b"token-sensitive".to_vec(),
                ..wire::ProtectedAttemptEndpoint::default()
            },
        )],
        launch_nonce_digest: [7; 32],
        payload_digest: [8; 32],
        peer_authority: authority(),
    };

    let debug = format!("{seal:?}");
    for sensitive in [
        "session-sensitive",
        "command-sensitive",
        "owner-sensitive",
        "runtime-sensitive",
        "address-sensitive",
    ] {
        assert!(!debug.contains(sensitive));
    }

    seal.zeroize();
    assert!(seal.identity.session_id.is_empty());
    assert!(seal.identity.command_id.is_empty());
    assert!(
        seal.identity
            .owner_agent_run_id
            .as_ref()
            .is_some_and(String::is_empty)
    );
    assert!(seal.runtime_instance_id.is_empty());
    assert!(seal.endpoints.is_empty());
    assert_eq!(seal.launch_nonce_digest, [0; 32]);
    assert_eq!(seal.payload_digest, [0; 32]);
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
