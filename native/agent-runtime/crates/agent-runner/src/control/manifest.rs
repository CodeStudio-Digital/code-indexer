use std::collections::BTreeMap;

use agent_protocol::generated::v1 as wire;

use super::error::ControlError;

const MAX_REFERENCE_TEXT_BYTES: usize = 512;

pub(super) fn validate_snapshot_manifest(
    actual: &[wire::SnapshotRef],
    expected: &[wire::SnapshotRef],
    collection: &'static str,
) -> Result<(), ControlError> {
    validate_snapshots(actual, collection)?;
    if snapshot_map(actual) != snapshot_map(expected) {
        return Err(ControlError::SnapshotCoverageMismatch);
    }
    Ok(())
}

pub(super) fn validate_artifact_manifest(
    actual: &[wire::ArtifactRef],
    expected: &[wire::ArtifactRef],
    owner_session_id: &str,
    budget: &wire::ResourceBudget,
) -> Result<(), ControlError> {
    validate_artifacts(actual, owner_session_id, Some(budget))?;
    if artifact_map(actual) != artifact_map(expected) {
        return Err(ControlError::ArtifactCoverageMismatch);
    }
    Ok(())
}

pub(super) fn validate_snapshots(
    snapshots: &[wire::SnapshotRef],
    collection: &'static str,
) -> Result<(), ControlError> {
    let mut refs = BTreeMap::new();
    for (index, snapshot) in snapshots.iter().enumerate() {
        for value in [
            snapshot.r#ref.as_str(),
            snapshot.origin.as_str(),
            snapshot.schema_id.as_str(),
        ] {
            validate_text(value).map_err(|reason| ControlError::InvalidSnapshot {
                collection,
                index,
                reason,
            })?;
        }
        if snapshot.version == 0 || snapshot.schema_version == 0 {
            return Err(ControlError::InvalidSnapshot {
                collection,
                index,
                reason: "versions must be positive",
            });
        }
        if snapshot.content_sha256.len() != 32 {
            return Err(ControlError::InvalidSnapshot {
                collection,
                index,
                reason: "content SHA-256 must have 32 bytes",
            });
        }
        if refs.insert(snapshot.r#ref.as_str(), snapshot).is_some() {
            return Err(ControlError::InvalidSnapshot {
                collection,
                index,
                reason: "snapshot ref is duplicated",
            });
        }
    }
    Ok(())
}

pub(super) fn validate_artifacts(
    artifacts: &[wire::ArtifactRef],
    owner_session_id: &str,
    budget: Option<&wire::ResourceBudget>,
) -> Result<(), ControlError> {
    let mut ids = BTreeMap::new();
    let mut total_bytes = 0_u64;
    for (index, artifact) in artifacts.iter().enumerate() {
        for value in [
            artifact.artifact_id.as_str(),
            artifact.kind.as_str(),
            artifact.media_type.as_str(),
            artifact.redaction_policy_version.as_str(),
            artifact.owner_session_id.as_str(),
        ] {
            validate_text(value)
                .map_err(|reason| ControlError::InvalidValidatedArtifact { index, reason })?;
        }
        if artifact.owner_session_id != owner_session_id {
            return Err(ControlError::ArtifactOwnerMismatch { index });
        }
        if artifact.content_sha256.len() != 32 || artifact.byte_length == 0 {
            return Err(ControlError::InvalidValidatedArtifact {
                index,
                reason: "hash must have 32 bytes and byte length must be positive",
            });
        }
        validate_artifact_enums(artifact, index)?;
        if ids
            .insert(artifact.artifact_id.as_str(), artifact)
            .is_some()
        {
            return Err(ControlError::InvalidValidatedArtifact {
                index,
                reason: "artifact ID is duplicated",
            });
        }
        total_bytes = total_bytes
            .checked_add(artifact.byte_length)
            .ok_or(ControlError::ArtifactBudgetExceeded)?;
        if let Some(budget) = budget
            && (artifact.byte_length > budget.max_artifact_bytes
                || total_bytes > budget.max_spool_bytes)
        {
            return Err(ControlError::ArtifactBudgetExceeded);
        }
    }
    Ok(())
}

fn validate_artifact_enums(artifact: &wire::ArtifactRef, index: usize) -> Result<(), ControlError> {
    let compression = wire::ArtifactCompression::try_from(artifact.compression).map_err(|_| {
        ControlError::InvalidValidatedArtifact {
            index,
            reason: "unknown compression",
        }
    })?;
    let privacy = wire::ArtifactPrivacyClass::try_from(artifact.privacy_class).map_err(|_| {
        ControlError::InvalidValidatedArtifact {
            index,
            reason: "unknown privacy class",
        }
    })?;
    if compression == wire::ArtifactCompression::Unspecified
        || privacy == wire::ArtifactPrivacyClass::Unspecified
    {
        return Err(ControlError::InvalidValidatedArtifact {
            index,
            reason: "compression and privacy class must be specified",
        });
    }
    Ok(())
}

fn snapshot_map(snapshots: &[wire::SnapshotRef]) -> BTreeMap<&str, &wire::SnapshotRef> {
    snapshots
        .iter()
        .map(|snapshot| (snapshot.r#ref.as_str(), snapshot))
        .collect()
}

fn artifact_map(artifacts: &[wire::ArtifactRef]) -> BTreeMap<&str, &wire::ArtifactRef> {
    artifacts
        .iter()
        .map(|artifact| (artifact.artifact_id.as_str(), artifact))
        .collect()
}

fn validate_text(value: &str) -> Result<(), &'static str> {
    if value.trim().is_empty() {
        return Err("text field is empty");
    }
    if value.contains('\0') {
        return Err("text field contains NUL");
    }
    if value.len() > MAX_REFERENCE_TEXT_BYTES {
        return Err("text field exceeds 512 bytes");
    }
    Ok(())
}
