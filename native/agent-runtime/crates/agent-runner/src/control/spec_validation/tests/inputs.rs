use agent_protocol::generated::v1 as wire;

use super::super::SpecValidationError;

use super::support::{artifact, snapshot, valid_spec, validate};

#[test]
fn role_definition_task_and_provider_are_mandatory() {
    let mut spec = valid_spec();
    spec.role.clear();
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidText { field: "role", .. })
    ));

    let mut spec = valid_spec();
    spec.agent_definition_id.clear();
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidText {
            field: "agent_definition_id",
            ..
        })
    ));

    let mut spec = valid_spec();
    spec.task = None;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::MissingTask
    );

    let mut spec = valid_spec();
    spec.provider_binding = None;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::MissingProviderBinding
    );
}

#[test]
fn provider_binding_must_be_resolved_and_explain_downgrades() {
    let mut spec = valid_spec();
    spec.provider_binding
        .as_mut()
        .expect("binding")
        .effective_model
        .clear();
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidText { .. })
    ));

    let mut spec = valid_spec();
    spec.provider_binding
        .as_mut()
        .expect("binding")
        .effective_model = "fallback-model".to_owned();
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::MissingDowngradeReason
    );

    let mut spec = valid_spec();
    spec.provider_binding
        .as_mut()
        .expect("binding")
        .effective_model = "fallback-model".to_owned();
    spec.downgrade_reasons.push(wire::ResolutionReason {
        code: "model_unavailable".to_owned(),
        dimension: "model".to_owned(),
        requested: Some("gpt-5".to_owned()),
        effective: Some("fallback-model".to_owned()),
        detail: None,
    });
    validate(spec).expect("explained downgrade");
}

#[test]
fn resolution_reasons_are_bounded_valid_and_unique() {
    let mut spec = valid_spec();
    spec.downgrade_reasons = (0..65)
        .map(|index| wire::ResolutionReason {
            code: format!("reason-{index}"),
            dimension: "model".to_owned(),
            ..Default::default()
        })
        .collect();
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::TooManyDowngradeReasons { .. })
    ));

    let mut spec = valid_spec();
    let reason = wire::ResolutionReason {
        code: "fallback".to_owned(),
        dimension: "model".to_owned(),
        ..Default::default()
    };
    spec.downgrade_reasons = vec![reason.clone(), reason];
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::DuplicateDowngradeReason { index: 1 }
    );
}

#[test]
fn artifacts_are_owned_hashed_bounded_and_exposed_by_borrow() {
    let mut spec = valid_spec();
    let input = artifact("task");
    spec.task.as_mut().expect("task").body = Some(wire::task_input::Body::Artifact(input));
    spec.task
        .as_mut()
        .expect("task")
        .attachments
        .push(artifact("attachment"));
    spec.checkpoint_input = Some(artifact("checkpoint"));
    spec.transcript_input = Some(artifact("transcript"));

    let validated = validate(spec).expect("valid artifacts");
    assert_eq!(validated.required_artifacts().count(), 4);

    let mut spec = valid_spec();
    let mut foreign = artifact("foreign");
    foreign.owner_session_id = "99999999-9999-4999-8999-999999999999".to_owned();
    spec.task.as_mut().expect("task").attachments.push(foreign);
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::ArtifactOwnerMismatch { index: 0 }
    );

    let mut spec = valid_spec();
    let duplicate = artifact("same");
    spec.task
        .as_mut()
        .expect("task")
        .attachments
        .extend([duplicate.clone(), duplicate]);
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::DuplicateArtifactId { index: 1 }
    );
}

#[test]
fn seven_core_valid_unique_snapshots_are_required() {
    let mut spec = valid_spec();
    spec.policy_snapshot = None;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::MissingRequiredSnapshot("policy_snapshot")
    );

    let mut spec = valid_spec();
    spec.preset_snapshot
        .as_mut()
        .expect("snapshot")
        .content_sha256 = vec![1; 31];
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidSnapshot {
            field: "preset_snapshot",
            ..
        })
    ));

    let mut spec = valid_spec();
    let duplicate_ref = spec.policy_snapshot.as_ref().expect("policy").r#ref.clone();
    spec.preset_snapshot.as_mut().expect("preset").r#ref = duplicate_ref;
    assert_eq!(
        validate(spec).unwrap_err(),
        SpecValidationError::DuplicateSnapshotRef {
            field: "preset_snapshot"
        }
    );
}

#[test]
fn codex_provider_requires_valid_eighth_snapshot() {
    let mut spec = valid_spec();
    let binding = spec.provider_binding.as_mut().expect("binding");
    binding.requested_provider = Some("codex_app_server".to_owned());
    binding.effective_provider = "codex_app_server".to_owned();
    assert_eq!(
        validate(spec.clone()).unwrap_err(),
        SpecValidationError::MissingRequiredSnapshot("codex_app_server_process_snapshot")
    );

    spec.codex_app_server_process_snapshot = Some(snapshot("codex-app-server"));
    assert_eq!(
        validate(spec.clone())
            .expect("valid Codex spec")
            .required_snapshots()
            .len(),
        8
    );

    spec.codex_app_server_process_snapshot
        .as_mut()
        .expect("Codex snapshot")
        .content_sha256 = vec![1; 31];
    assert!(matches!(
        validate(spec),
        Err(SpecValidationError::InvalidSnapshot {
            field: "codex_app_server_process_snapshot",
            ..
        })
    ));
}
