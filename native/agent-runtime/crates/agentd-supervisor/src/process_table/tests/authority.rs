use super::fakes::FakeContainment;
use super::fixtures::{drops, metadata, registry, spawn_running};

#[test]
fn renewal_preserves_sibling_authority_and_cannot_revive_a_terminating_process() {
    let mut registry = registry(2);
    let port = FakeContainment::with_group(drops());
    let first = spawn_running(&mut registry, &port, metadata("attempt-1", 3, "runtime-1"));
    let mut sibling = metadata("attempt-2", 3, "runtime-2");
    sibling.lease_expires_at_unix_ms = 1_800;
    let second = spawn_running(
        &mut registry,
        &FakeContainment::with_group(drops()),
        sibling,
    );
    registry
        .renew_authority(&first, 1_900, 2_000, 1_499)
        .unwrap();
    assert_eq!(
        registry.metadata(&first).unwrap().lease_expires_at_unix_ms,
        1_900
    );
    assert_eq!(
        registry.metadata(&second).unwrap().lease_expires_at_unix_ms,
        1_800
    );
    registry.terminate(&port, &first, 1).unwrap();
    assert!(
        registry
            .renew_authority(&first, 2_000, 2_000, 1_500)
            .is_err()
    );
    assert!(
        registry
            .renew_authority(&second, 2_000, 2_000, 1_800)
            .is_err()
    );
}
