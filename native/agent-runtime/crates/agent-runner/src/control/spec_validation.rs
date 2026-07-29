//! Fail-closed validation for the executable V1 attempt specification.

use agent_protocol::generated::v1 as wire;
use agent_protocol::wire_identity::identity_from_wire;

#[path = "spec_validation/budget.rs"]
mod budget;
#[path = "spec_validation/error.rs"]
mod error;
#[path = "spec_validation/graph.rs"]
mod graph;
#[path = "spec_validation/inputs.rs"]
mod inputs;
#[path = "spec_validation/snapshots.rs"]
mod snapshots;
#[cfg(test)]
#[path = "spec_validation/tests.rs"]
mod tests;
#[path = "spec_validation/text.rs"]
mod text;

pub use error::SpecValidationError;

use budget::{validate_resource_budget, validate_run_tree_budget};
use graph::{validate_run_graph, validate_trigger};
use inputs::{validate_provider_binding, validate_resolution_reasons, validate_task};
use snapshots::validate_required_snapshots;
use text::validate_required_text;

pub(super) const RESOLVED_ATTEMPT_SPEC_SCHEMA_V1: u32 = 1;

/// Immutable authority against which a decoded specification is checked.
#[derive(Debug, Clone, Copy)]
pub(super) struct SpecValidationContext<'a> {
    pub expected_identity: &'a wire::AttemptIdentity,
    pub launch_resource_budget: &'a wire::ResourceBudget,
    pub launch_hard_deadline_at_unix_ms: i64,
    pub observed_at_unix_ms: i64,
}

/// A specification whose complete V1 executable surface has been validated.
#[derive(Debug)]
pub(super) struct ValidatedSpec {
    spec: wire::ResolvedAttemptSpec,
}

impl ValidatedSpec {
    #[must_use]
    pub(super) const fn as_wire(&self) -> &wire::ResolvedAttemptSpec {
        &self.spec
    }

    #[must_use]
    pub(super) fn required_snapshots(&self) -> [&wire::SnapshotRef; 7] {
        snapshots::required_snapshots(&self.spec)
            .unwrap_or_else(|| unreachable!("validated spec always has seven snapshots"))
    }

    pub(super) fn required_artifacts(&self) -> impl Iterator<Item = &wire::ArtifactRef> {
        let task_artifact = self.spec.task.as_ref().and_then(|task| {
            task.body.as_ref().and_then(|body| match body {
                wire::task_input::Body::Artifact(artifact) => Some(artifact),
                wire::task_input::Body::InlineUtf8(_) => None,
            })
        });
        let attachments = self
            .spec
            .task
            .as_ref()
            .into_iter()
            .flat_map(|task| task.attachments.iter());

        task_artifact
            .into_iter()
            .chain(attachments)
            .chain(self.spec.checkpoint_input.iter())
            .chain(self.spec.transcript_input.iter())
    }
}

/// Validates all executable fields understood by schema V1.
///
/// Unknown/newer schemas fail closed. The decoded message is consumed and
/// retained without cloning its potentially large task and manifests.
pub(super) fn validate_resolved_attempt_spec_v1(
    spec: wire::ResolvedAttemptSpec,
    context: SpecValidationContext<'_>,
) -> Result<ValidatedSpec, SpecValidationError> {
    validate_context(context)?;
    if spec.schema_version != RESOLVED_ATTEMPT_SPEC_SCHEMA_V1 {
        return Err(SpecValidationError::UnsupportedSchemaVersion(
            spec.schema_version,
        ));
    }
    if spec.spec_version == 0 {
        return Err(SpecValidationError::ZeroSpecVersion);
    }
    if spec.ordinal == 0 {
        return Err(SpecValidationError::ZeroOrdinal);
    }

    let identity = spec
        .identity
        .as_ref()
        .ok_or(SpecValidationError::MissingIdentity)?;
    identity_from_wire(identity).map_err(SpecValidationError::InvalidIdentity)?;
    if identity != context.expected_identity {
        return Err(SpecValidationError::IdentityMismatch);
    }

    validate_trigger(spec.trigger, spec.ordinal)?;
    validate_run_graph(identity, spec.spawn_depth)?;
    validate_required_text("role", &spec.role)?;
    validate_required_text("agent_definition_id", &spec.agent_definition_id)?;
    validate_provider_binding(spec.provider_binding.as_ref())?;
    validate_resolution_reasons(&spec.downgrade_reasons, spec.provider_binding.as_ref())?;
    validate_wait_mode(spec.wait_mode)?;

    let resource_budget = spec
        .resource_budget
        .as_ref()
        .ok_or(SpecValidationError::MissingResourceBudget)?;
    validate_resource_budget(resource_budget)?;
    if resource_budget != context.launch_resource_budget {
        return Err(SpecValidationError::LaunchBudgetMismatch);
    }
    validate_run_tree_budget(
        spec.run_tree_budget.as_ref(),
        resource_budget,
        spec.spawn_depth,
    )?;
    validate_task(&spec, identity.session_id.as_str(), resource_budget)?;

    if spec.workspace_lease_fencing_epoch == 0 {
        return Err(SpecValidationError::ZeroWorkspaceLeaseFence);
    }
    validate_required_snapshots(&spec)?;
    validate_deadline(&spec, context)?;
    Ok(ValidatedSpec { spec })
}

fn validate_context(context: SpecValidationContext<'_>) -> Result<(), SpecValidationError> {
    identity_from_wire(context.expected_identity)
        .map_err(SpecValidationError::InvalidLaunchIdentity)?;
    if context.launch_hard_deadline_at_unix_ms <= 0 {
        return Err(SpecValidationError::InvalidLaunchDeadline(
            context.launch_hard_deadline_at_unix_ms,
        ));
    }
    if context.observed_at_unix_ms <= 0 {
        return Err(SpecValidationError::InvalidObservedTime(
            context.observed_at_unix_ms,
        ));
    }
    validate_resource_budget(context.launch_resource_budget)
        .map_err(|error| SpecValidationError::InvalidLaunchBudget(Box::new(error)))
}

fn validate_wait_mode(value: i32) -> Result<wire::AgentRunWaitMode, SpecValidationError> {
    let mode = wire::AgentRunWaitMode::try_from(value)
        .map_err(|_| SpecValidationError::UnknownWaitMode(value))?;
    if mode == wire::AgentRunWaitMode::Unspecified {
        return Err(SpecValidationError::UnspecifiedWaitMode);
    }
    Ok(mode)
}

const fn validate_deadline(
    spec: &wire::ResolvedAttemptSpec,
    context: SpecValidationContext<'_>,
) -> Result<(), SpecValidationError> {
    if spec.deadline_at_unix_ms <= 0 {
        return Err(SpecValidationError::InvalidDeadline(
            spec.deadline_at_unix_ms,
        ));
    }
    if spec.deadline_at_unix_ms > context.launch_hard_deadline_at_unix_ms {
        return Err(SpecValidationError::DeadlineExceedsLaunch {
            requested: spec.deadline_at_unix_ms,
            launch: context.launch_hard_deadline_at_unix_ms,
        });
    }
    if context.observed_at_unix_ms >= spec.deadline_at_unix_ms {
        return Err(SpecValidationError::DeadlineExpired {
            deadline: spec.deadline_at_unix_ms,
            observed: context.observed_at_unix_ms,
        });
    }
    Ok(())
}
