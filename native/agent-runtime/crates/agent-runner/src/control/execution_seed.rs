use std::fmt::{self, Debug, Formatter};

use agent_protocol::generated::v1 as wire;

/// Single-owned executable input retained after complete spec validation.
///
/// The seed is intentionally non-cloneable: large task/context inputs must not
/// multiply while the attempt crosses hydration and activation boundaries.
pub struct RunnerExecutionSeed {
    spec: Box<wire::ResolvedAttemptSpec>,
}

impl RunnerExecutionSeed {
    pub(in crate::control) fn from_validated(spec: wire::ResolvedAttemptSpec) -> Self {
        Self {
            spec: Box::new(spec),
        }
    }

    pub const fn as_wire(&self) -> &wire::ResolvedAttemptSpec {
        &self.spec
    }
}

impl Debug for RunnerExecutionSeed {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerExecutionSeed")
            .field("schema_version", &self.spec.schema_version)
            .field("spec_version", &self.spec.spec_version)
            .field("ordinal", &self.spec.ordinal)
            .field("spawn_depth", &self.spec.spawn_depth)
            .field(
                "attachment_count",
                &self
                    .spec
                    .task
                    .as_ref()
                    .map_or(0, |task| task.attachments.len()),
            )
            .field("task", &"[REDACTED]")
            .field("provider_binding", &"[SEALED]")
            .finish_non_exhaustive()
    }
}
