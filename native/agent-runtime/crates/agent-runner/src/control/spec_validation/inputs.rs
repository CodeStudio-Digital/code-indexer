use std::collections::BTreeSet;

use agent_protocol::generated::v1 as wire;

use super::SpecValidationError;
use super::text::{validate_optional_text, validate_required_text, validate_text};

const MAX_INLINE_TASK_BYTES: usize = 64 * 1024;
const MAX_ATTACHMENTS: usize = 128;
const MAX_DOWNGRADE_REASONS: usize = 64;

pub(super) fn validate_provider_binding(
    binding: Option<&wire::ProviderBinding>,
) -> Result<(), SpecValidationError> {
    let binding = binding.ok_or(SpecValidationError::MissingProviderBinding)?;
    validate_required_text(
        "provider_binding.effective_provider",
        &binding.effective_provider,
    )?;
    validate_required_text("provider_binding.effective_model", &binding.effective_model)?;
    for (field, value) in [
        (
            "provider_binding.requested_provider",
            binding.requested_provider.as_deref(),
        ),
        (
            "provider_binding.requested_model",
            binding.requested_model.as_deref(),
        ),
        (
            "provider_binding.requested_reasoning_effort",
            binding.requested_reasoning_effort.as_deref(),
        ),
        (
            "provider_binding.requested_preset",
            binding.requested_preset.as_deref(),
        ),
        (
            "provider_binding.effective_reasoning_effort",
            binding.effective_reasoning_effort.as_deref(),
        ),
        (
            "provider_binding.effective_preset",
            binding.effective_preset.as_deref(),
        ),
    ] {
        validate_optional_text(field, value)?;
    }
    Ok(())
}

pub(super) fn validate_resolution_reasons(
    reasons: &[wire::ResolutionReason],
    binding: Option<&wire::ProviderBinding>,
) -> Result<(), SpecValidationError> {
    if reasons.len() > MAX_DOWNGRADE_REASONS {
        return Err(SpecValidationError::TooManyDowngradeReasons {
            count: reasons.len(),
            maximum: MAX_DOWNGRADE_REASONS,
        });
    }
    let mut keys = BTreeSet::new();
    for (index, reason) in reasons.iter().enumerate() {
        validate_required_text("downgrade_reasons.code", &reason.code)?;
        validate_required_text("downgrade_reasons.dimension", &reason.dimension)?;
        for (field, value) in [
            ("downgrade_reasons.requested", reason.requested.as_deref()),
            ("downgrade_reasons.effective", reason.effective.as_deref()),
            ("downgrade_reasons.detail", reason.detail.as_deref()),
        ] {
            validate_optional_text(field, value)?;
        }
        if !keys.insert((reason.code.as_str(), reason.dimension.as_str())) {
            return Err(SpecValidationError::DuplicateDowngradeReason { index });
        }
    }

    if reasons.is_empty() && binding.is_some_and(binding_has_downgrade) {
        return Err(SpecValidationError::MissingDowngradeReason);
    }
    Ok(())
}

pub(super) fn validate_task(
    spec: &wire::ResolvedAttemptSpec,
    owner_session_id: &str,
    budget: &wire::ResourceBudget,
) -> Result<(), SpecValidationError> {
    let task = spec.task.as_ref().ok_or(SpecValidationError::MissingTask)?;
    if task.attachments.len() > MAX_ATTACHMENTS {
        return Err(SpecValidationError::TooManyAttachments {
            count: task.attachments.len(),
            maximum: MAX_ATTACHMENTS,
        });
    }
    match task
        .body
        .as_ref()
        .ok_or(SpecValidationError::MissingTaskBody)?
    {
        wire::task_input::Body::InlineUtf8(value) => {
            if value.len() > MAX_INLINE_TASK_BYTES {
                return Err(SpecValidationError::InlineTaskTooLarge {
                    length: value.len(),
                    maximum: MAX_INLINE_TASK_BYTES,
                });
            }
            validate_text("task.inline_utf8", value, MAX_INLINE_TASK_BYTES)?;
        }
        wire::task_input::Body::Artifact(_) => {}
    }
    validate_input_artifacts(spec, owner_session_id, budget)
}

fn binding_has_downgrade(binding: &wire::ProviderBinding) -> bool {
    differs(
        binding.requested_provider.as_deref(),
        Some(binding.effective_provider.as_str()),
    ) || differs(
        binding.requested_model.as_deref(),
        Some(binding.effective_model.as_str()),
    ) || differs(
        binding.requested_reasoning_effort.as_deref(),
        binding.effective_reasoning_effort.as_deref(),
    ) || differs(
        binding.requested_preset.as_deref(),
        binding.effective_preset.as_deref(),
    )
}

fn differs(requested: Option<&str>, effective: Option<&str>) -> bool {
    requested.is_some_and(|requested| Some(requested) != effective)
}

fn validate_input_artifacts(
    spec: &wire::ResolvedAttemptSpec,
    owner_session_id: &str,
    budget: &wire::ResourceBudget,
) -> Result<(), SpecValidationError> {
    let task = spec.task.as_ref().ok_or(SpecValidationError::MissingTask)?;
    let body_artifact = task.body.as_ref().and_then(|body| match body {
        wire::task_input::Body::Artifact(artifact) => Some(artifact),
        wire::task_input::Body::InlineUtf8(_) => None,
    });
    let artifacts = body_artifact
        .into_iter()
        .chain(task.attachments.iter())
        .chain(spec.checkpoint_input.iter())
        .chain(spec.transcript_input.iter());
    let mut ids = BTreeSet::new();
    let mut total_bytes = 0_u64;

    for (index, artifact) in artifacts.enumerate() {
        validate_artifact(artifact, index, owner_session_id)?;
        if !ids.insert(artifact.artifact_id.as_str()) {
            return Err(SpecValidationError::DuplicateArtifactId { index });
        }
        total_bytes = total_bytes
            .checked_add(artifact.byte_length)
            .ok_or(SpecValidationError::ArtifactBudgetExceeded)?;
        if artifact.byte_length > budget.max_artifact_bytes || total_bytes > budget.max_spool_bytes
        {
            return Err(SpecValidationError::ArtifactBudgetExceeded);
        }
    }
    Ok(())
}

fn validate_artifact(
    artifact: &wire::ArtifactRef,
    index: usize,
    owner_session_id: &str,
) -> Result<(), SpecValidationError> {
    for value in [
        artifact.artifact_id.as_str(),
        artifact.kind.as_str(),
        artifact.media_type.as_str(),
        artifact.redaction_policy_version.as_str(),
        artifact.owner_session_id.as_str(),
    ] {
        validate_required_text("artifact field", value).map_err(|_| {
            SpecValidationError::InvalidArtifact {
                index,
                reason: "required text field is invalid",
            }
        })?;
    }
    if artifact.owner_session_id != owner_session_id {
        return Err(SpecValidationError::ArtifactOwnerMismatch { index });
    }
    if artifact.content_sha256.len() != 32 || artifact.byte_length == 0 {
        return Err(SpecValidationError::InvalidArtifact {
            index,
            reason: "hash must have 32 bytes and byte length must be positive",
        });
    }
    validate_artifact_enums(artifact, index)
}

fn validate_artifact_enums(
    artifact: &wire::ArtifactRef,
    index: usize,
) -> Result<(), SpecValidationError> {
    let compression = wire::ArtifactCompression::try_from(artifact.compression).map_err(|_| {
        SpecValidationError::InvalidArtifact {
            index,
            reason: "unknown compression",
        }
    })?;
    let privacy = wire::ArtifactPrivacyClass::try_from(artifact.privacy_class).map_err(|_| {
        SpecValidationError::InvalidArtifact {
            index,
            reason: "unknown privacy class",
        }
    })?;
    if compression == wire::ArtifactCompression::Unspecified
        || privacy == wire::ArtifactPrivacyClass::Unspecified
    {
        return Err(SpecValidationError::InvalidArtifact {
            index,
            reason: "compression and privacy class must be specified",
        });
    }
    Ok(())
}
