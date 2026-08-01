use crate::generated::v1 as wire;
use crate::pulse_channel::RunnerPulseAuthenticationKey;

use super::ShapeValidatedRunnerLaunchHandoff;
use crate::runner_bootstrap::{RunnerBootstrapError, RunnerEndpointTokenVerifier};

impl ShapeValidatedRunnerLaunchHandoff {
    /// Moves one endpoint-bound token verifier out of this handoff.
    ///
    /// # Errors
    ///
    /// Rejects an unknown/unspecified kind or an already-consumed verifier.
    pub fn take_endpoint_token_verifier(
        &mut self,
        kind: wire::AttemptEndpointKind,
    ) -> Result<RunnerEndpointTokenVerifier, RunnerBootstrapError> {
        let index = self
            .metadata
            .endpoints
            .iter()
            .position(|endpoint| endpoint.kind == kind as i32)
            .ok_or(RunnerBootstrapError::InvalidField {
                message: "ShapeValidatedRunnerLaunchHandoff",
                field: "endpoint_kind",
            })?;
        self.secrets
            .take_endpoint_token_verifier(index)
            .ok_or(RunnerBootstrapError::InvalidField {
                message: "ShapeValidatedRunnerLaunchHandoff",
                field: "endpoint_token_authority",
            })
    }

    /// Moves the endpoint-derived pulse signing key out exactly once.
    ///
    /// # Errors
    ///
    /// Returns an invalid-field error after the single-use key was consumed.
    pub fn take_runner_pulse_key(
        &mut self,
    ) -> Result<RunnerPulseAuthenticationKey, RunnerBootstrapError> {
        self.secrets
            .take_runner_pulse_key()
            .ok_or(RunnerBootstrapError::InvalidField {
                message: "ShapeValidatedRunnerLaunchHandoff",
                field: "runner_pulse_key_authority",
            })
    }
}
