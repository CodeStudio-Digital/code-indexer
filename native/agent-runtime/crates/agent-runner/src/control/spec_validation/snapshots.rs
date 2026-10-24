use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;

use super::SpecValidationError;
use super::text::validate_required_text;

pub(super) fn validate_required_snapshots(
    spec: &wire::ResolvedAttemptSpec,
) -> Result<(), SpecValidationError> {
    let snapshots = required_snapshots(spec).ok_or_else(|| first_missing_snapshot(spec))?;
    let mut refs = BTreeSet::new();

    for (field, snapshot) in snapshot_fields(spec, &snapshots) {
        validate_snapshot(field, snapshot)?;
        if !refs.insert(snapshot.r#ref.as_str()) {
            return Err(SpecValidationError::DuplicateSnapshotRef { field });
        }
    }
    Ok(())
}

pub(super) fn required_snapshots(
    spec: &wire::ResolvedAttemptSpec,
) -> Option<Vec<&wire::SnapshotRef>> {
    let mut snapshots = vec![
        spec.verifier_policy_snapshot.as_ref()?,
        spec.capability_set_snapshot.as_ref()?,
        spec.environment_snapshot.as_ref()?,
        spec.workspace_lease_snapshot.as_ref()?,
        spec.policy_snapshot.as_ref()?,
        spec.preset_snapshot.as_ref()?,
        spec.agent_definition_snapshot.as_ref()?,
    ];
    if spec
        .provider_binding
        .as_ref()
        .is_some_and(|binding| binding.effective_provider == "codex_app_server")
    {
        snapshots.push(spec.codex_app_server_process_snapshot.as_ref()?);
    } else if let Some(snapshot) = spec.codex_app_server_process_snapshot.as_ref() {
        snapshots.push(snapshot);
    }
    if let Some(snapshot) = spec.initial_conversation_snapshot.as_ref() {
        snapshots.push(snapshot);
    }
    Some(snapshots)
}

fn snapshot_fields<'a>(
    spec: &wire::ResolvedAttemptSpec,
    snapshots: &'a [&'a wire::SnapshotRef],
) -> impl Iterator<Item = (&'static str, &'a wire::SnapshotRef)> {
    let mut fields = vec![
        "verifier_policy_snapshot",
        "capability_set_snapshot",
        "environment_snapshot",
        "workspace_lease_snapshot",
        "policy_snapshot",
        "preset_snapshot",
        "agent_definition_snapshot",
    ];
    if spec.codex_app_server_process_snapshot.is_some() {
        fields.push("codex_app_server_process_snapshot");
    }
    if spec.initial_conversation_snapshot.is_some() {
        fields.push("initial_conversation_snapshot");
    }
    fields.into_iter().zip(snapshots.iter().copied())
}

fn first_missing_snapshot(spec: &wire::ResolvedAttemptSpec) -> SpecValidationError {
    let codex_snapshot_required = spec
        .provider_binding
        .as_ref()
        .is_some_and(|binding| binding.effective_provider == "codex_app_server");
    let missing = [
        (
            "verifier_policy_snapshot",
            spec.verifier_policy_snapshot.is_none(),
        ),
        (
            "capability_set_snapshot",
            spec.capability_set_snapshot.is_none(),
        ),
        ("environment_snapshot", spec.environment_snapshot.is_none()),
        (
            "workspace_lease_snapshot",
            spec.workspace_lease_snapshot.is_none(),
        ),
        ("policy_snapshot", spec.policy_snapshot.is_none()),
        ("preset_snapshot", spec.preset_snapshot.is_none()),
        (
            "agent_definition_snapshot",
            spec.agent_definition_snapshot.is_none(),
        ),
        (
            "codex_app_server_process_snapshot",
            codex_snapshot_required && spec.codex_app_server_process_snapshot.is_none(),
        ),
    ]
    .into_iter()
    .find_map(|(field, absent)| absent.then_some(field))
    .unwrap_or("unknown_snapshot");
    SpecValidationError::MissingRequiredSnapshot(missing)
}

fn validate_snapshot(
    field: &'static str,
    snapshot: &wire::SnapshotRef,
) -> Result<(), SpecValidationError> {
    for (name, value) in [
        ("snapshot.ref", snapshot.r#ref.as_str()),
        ("snapshot.origin", snapshot.origin.as_str()),
        ("snapshot.schema_id", snapshot.schema_id.as_str()),
    ] {
        validate_required_text(name, value).map_err(|_| SpecValidationError::InvalidSnapshot {
            field,
            reason: "required text field is invalid",
        })?;
    }
    if snapshot.version == 0 || snapshot.schema_version == 0 {
        return Err(SpecValidationError::InvalidSnapshot {
            field,
            reason: "versions must be positive",
        });
    }
    if snapshot.content_sha256.len() != 32 {
        return Err(SpecValidationError::InvalidSnapshot {
            field,
            reason: "content SHA-256 must contain 32 bytes",
        });
    }
    Ok(())
}
