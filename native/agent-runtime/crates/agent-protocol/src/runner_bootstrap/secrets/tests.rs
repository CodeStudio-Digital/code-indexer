use super::scrub::scrub_handoff;
use super::{ProtectedLaunchSecrets, scrub_and_clear_handoff};
use crate::generated::v1 as wire;

#[test]
fn scrub_overwrites_every_raw_bootstrap_secret() {
    let mut endpoint = wire::RunnerLaunchEndpoint::default();
    endpoint.connection_token = vec![3, 4];
    let mut handoff = wire::RunnerLaunchHandoff {
        launch_nonce: vec![1, 2],
        endpoints: vec![endpoint],
        ..Default::default()
    };

    scrub_handoff(&mut handoff);

    assert_eq!(handoff.launch_nonce, [0, 0]);
    assert_eq!(handoff.endpoints[0].connection_token, [0, 0]);
}

#[test]
fn protected_secrets_retain_only_the_single_use_nonce_and_token_hashes() {
    let mut endpoint = wire::RunnerLaunchEndpoint::default();
    endpoint.kind = wire::AttemptEndpointKind::Control as i32;
    endpoint.connection_id = "connection:control".into();
    endpoint.connection_token = vec![2; 16];
    let mut handoff = wire::RunnerLaunchHandoff {
        launch_nonce: vec![1; 16],
        endpoints: vec![endpoint],
        ..Default::default()
    };
    let digest = [9; 32];
    let mut protected = ProtectedLaunchSecrets::take_from(&mut handoff, digest);
    scrub_and_clear_handoff(&mut handoff);

    assert!(handoff.launch_nonce.is_empty());
    assert!(handoff.endpoints[0].connection_token.is_empty());
    assert!(protected.launch_nonce_matches(&[1; 16]));
    let verifier = protected
        .take_endpoint_token_verifier(0)
        .expect("endpoint verifier");
    assert!(verifier.is_bound_to(
        &digest,
        wire::AttemptEndpointKind::Control,
        "connection:control"
    ));
    assert!(verifier.matches(&[2; 16]));
    assert!(!verifier.matches(&[3; 16]));
    assert!(protected.take_endpoint_token_verifier(0).is_none());
    assert!(protected.take_launch_nonce().is_some());
    assert!(!protected.launch_nonce_matches(&[1; 16]));
}
