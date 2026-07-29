use agent_protocol::generated::v1 as wire;

use super::super::{SpecValidationContext, SpecValidationError, validate_resolved_attempt_spec_v1};

use super::support::{
    LAUNCH_DEADLINE, NOW, identity, resource_budget, valid_spec, validate,
    validate_with_spec_identity,
};

#[test]
fn complete_v1_spec_is_sealed_without_manifest_clones() {
    let validated = validate(valid_spec()).expect("valid spec");

    assert_eq!(validated.as_wire().schema_version, 1);
    assert_eq!(validated.required_snapshots().len(), 7);
    assert_eq!(validated.required_artifacts().count(), 0);
    assert_eq!(validated.as_wire().resource_budget, Some(resource_budget()));
    assert_eq!(validated.as_wire().agent_definition_id, "native-coder");
}

#[test]
fn only_schema_v1_and_positive_versions_are_accepted() {
    let mut spec = valid_spec();
    spec.schema_version = 2;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::UnsupportedSchemaVersion(2)
    );

    let mut spec = valid_spec();
    spec.spec_version = 0;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::ZeroSpecVersion
    );

    let mut spec = valid_spec();
    spec.ordinal = 0;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::ZeroOrdinal
    );
}

#[test]
fn trigger_and_wait_mode_reject_unknown_unspecified_and_incoherent_values() {
    let mut spec = valid_spec();
    spec.trigger = 99;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::UnknownTrigger(99)
    );

    let mut spec = valid_spec();
    spec.trigger = wire::AttemptTrigger::Unspecified as i32;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::UnspecifiedTrigger
    );

    let mut spec = valid_spec();
    spec.trigger = wire::AttemptTrigger::Resume as i32;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::TriggerOrdinalMismatch
    );

    let mut spec = valid_spec();
    spec.wait_mode = 99;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::UnknownWaitMode(99)
    );
}

#[test]
fn launch_identity_is_authoritative() {
    let mut spec = valid_spec();
    spec.identity.as_mut().expect("identity").attempt_id =
        "99999999-9999-4999-8999-999999999999".to_owned();
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::IdentityMismatch
    );
}

#[test]
fn root_and_child_graph_shapes_are_checked() {
    let mut invalid_root = valid_spec();
    invalid_root.spawn_depth = 1;
    assert!(matches!(
        validate(invalid_root),
        Err(SpecValidationError::InvalidRunGraph(_))
    ));

    let mut child = valid_spec();
    let child_identity = child.identity.as_mut().expect("identity");
    child_identity.agent_run_id = "66666666-6666-4666-8666-666666666666".to_owned();
    child_identity.owner_agent_run_id = Some("33333333-3333-4333-8333-333333333333".to_owned());
    child_identity.parent_agent_run_id = Some("33333333-3333-4333-8333-333333333333".to_owned());
    child.spawn_depth = 1;
    validate(child).expect_err("launch identity must still match child identity");
}

#[test]
fn valid_child_graph_passes_when_launch_identity_matches() {
    let mut spec = valid_spec();
    let child_identity = spec.identity.as_mut().expect("identity");
    child_identity.agent_run_id = "66666666-6666-4666-8666-666666666666".to_owned();
    child_identity.owner_agent_run_id = Some("77777777-7777-4777-8777-777777777777".to_owned());
    child_identity.parent_agent_run_id = Some("88888888-8888-4888-8888-888888888888".to_owned());
    spec.spawn_depth = 1;

    validate_with_spec_identity(spec).expect("valid child with distinct owner and parent");
}

#[test]
fn deadline_is_positive_live_and_bounded_by_launch() {
    let mut spec = valid_spec();
    spec.deadline_at_unix_ms = 0;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::InvalidDeadline(0)
    );

    let mut spec = valid_spec();
    spec.deadline_at_unix_ms = NOW;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::DeadlineExpired { .. })
    ));

    let mut spec = valid_spec();
    spec.deadline_at_unix_ms = LAUNCH_DEADLINE + 1;
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::DeadlineExceedsLaunch { .. })
    ));
}

#[test]
fn workspace_fence_must_be_positive_but_is_an_independent_domain() {
    let mut spec = valid_spec();
    spec.workspace_lease_fencing_epoch = 8;
    validate(spec).expect("workspace and attempt fences may differ");

    let mut spec = valid_spec();
    spec.workspace_lease_fencing_epoch = 0;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::ZeroWorkspaceLeaseFence
    );
}

#[test]
fn invalid_validation_context_fails_closed() {
    let expected_identity = identity();
    let launch_budget = resource_budget();
    let result = validate_resolved_attempt_spec_v1(
        valid_spec(),
        SpecValidationContext {
            expected_identity: &expected_identity,
            launch_resource_budget: &launch_budget,
            launch_hard_deadline_at_unix_ms: 0,
            observed_at_unix_ms: NOW,
        },
    );

    assert_eq!(
        result.unwrap_err(),
        SpecValidationError::InvalidLaunchDeadline(0)
    );
}
