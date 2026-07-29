use super::{MAX_WIRE_IDENTIFIER_BYTES, WireIdentityError, identity_from_wire, identity_to_wire};
use crate::generated::v1 as wire;

fn valid_wire_identity() -> wire::AttemptIdentity {
    wire::AttemptIdentity {
        session_id: "11111111-1111-4111-8111-111111111111".into(),
        command_id: "22222222-2222-4222-8222-222222222222".into(),
        agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        attempt_id: "44444444-4444-4444-8444-444444444444".into(),
        executor_owner_id: "owner".into(),
        fencing_epoch: u64::MAX,
        correlation_id: "55555555-5555-4555-8555-555555555555".into(),
        root_agent_run_id: "33333333-3333-4333-8333-333333333333".into(),
        owner_agent_run_id: Some("77777777-7777-4777-8777-777777777777".into()),
        parent_agent_run_id: None,
    }
}

#[test]
fn generated_and_semantic_identity_round_trip_without_numeric_loss() {
    let wire = valid_wire_identity();
    let semantic = identity_from_wire(&wire).expect("valid semantic identity");

    assert_eq!(semantic.fencing_epoch, u64::MAX);
    assert_eq!(
        semantic.attempt_id.as_str(),
        "44444444-4444-4444-8444-444444444444"
    );
    assert_eq!(identity_to_wire(&semantic), wire);
}

#[test]
fn missing_and_invalid_identifiers_fail_before_dispatch() {
    let mut missing = valid_wire_identity();
    missing.attempt_id.clear();
    assert_eq!(
        identity_from_wire(&missing),
        Err(WireIdentityError::MissingField("attempt_id"))
    );

    let mut invalid = valid_wire_identity();
    invalid.correlation_id = " \t".into();
    assert!(matches!(
        identity_from_wire(&invalid),
        Err(WireIdentityError::InvalidUuidField {
            field: "correlation_id",
            ..
        })
    ));

    let mut contains_nul = valid_wire_identity();
    contains_nul.command_id = "command\0suffix".into();
    assert_eq!(
        identity_from_wire(&contains_nul),
        Err(WireIdentityError::ContainsNul("command_id"))
    );
}

#[test]
fn noncanonical_operational_uuid_fails_before_dispatch() {
    let mut opaque = valid_wire_identity();
    opaque.agent_run_id = "run:opaque".into();
    assert!(matches!(
        identity_from_wire(&opaque),
        Err(WireIdentityError::InvalidUuidField {
            field: "agent_run_id",
            ..
        })
    ));

    let mut uppercase = valid_wire_identity();
    uppercase.attempt_id = "44444444-4444-4444-8444-44444444444A".into();
    assert!(matches!(
        identity_from_wire(&uppercase),
        Err(WireIdentityError::InvalidUuidField {
            field: "attempt_id",
            ..
        })
    ));
}

#[test]
fn oversized_identity_fails_before_domain_allocation() {
    let mut oversized = valid_wire_identity();
    oversized.session_id = "x".repeat(MAX_WIRE_IDENTIFIER_BYTES + 1);

    assert!(matches!(
        identity_from_wire(&oversized),
        Err(WireIdentityError::FieldTooLong {
            field: "session_id",
            ..
        })
    ));
}

#[test]
fn zero_fencing_epoch_is_never_semantic_authority() {
    let mut invalid = valid_wire_identity();
    invalid.fencing_epoch = 0;

    assert_eq!(
        identity_from_wire(&invalid),
        Err(WireIdentityError::ZeroFencingEpoch)
    );
}
