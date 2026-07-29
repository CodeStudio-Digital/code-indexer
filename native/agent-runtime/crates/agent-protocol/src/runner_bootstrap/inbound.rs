use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use prost::Message;

use crate::frame::{BootstrapAttemptChannel, BootstrapChannelError, BootstrapError};
use crate::generated::v1 as wire;

use super::secrets::{
    ProtectedLaunchSecrets, RunnerEndpointTokenVerifier, ScrubbedBytes, ScrubbedHandoff,
    scrub_agent_hello, scrub_and_clear_handoff,
};
use super::validation::validate_handoff;
use super::{
    RUNNER_LAUNCH_HANDOFF_MAX_BYTES, RunnerBootstrapError, runner_launch_handoff_sha256,
    validate_size,
};

mod asynchronous;
mod preflight;

pub struct ShapeValidatedRunnerLaunchHandoff {
    metadata: wire::RunnerLaunchHandoff,
    secrets: ProtectedLaunchSecrets,
    digest: [u8; 32],
}

/// Sole plaintext launch-nonce owner.
///
/// It cannot be cloned or converted into bytes:
///
/// ```compile_fail
/// use agent_protocol::runner_bootstrap::PendingRunnerLaunchNonce;
///
/// fn require_clone<T: Clone>() {}
/// require_clone::<PendingRunnerLaunchNonce>();
/// ```
pub struct PendingRunnerLaunchNonce {
    bytes: ScrubbedBytes,
}

/// Owned `AgentHello` whose nonce can only reach the one-shot channel commit.
pub struct PendingRunnerAgentHello {
    hello: Option<wire::AgentHello>,
}

impl Debug for ShapeValidatedRunnerLaunchHandoff {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ShapeValidatedRunnerLaunchHandoff")
            .field("metadata", &self.metadata)
            .field("secrets", &"[PROTECTED; REDACTED]")
            .field("digest", &"[REDACTED]")
            .finish()
    }
}

impl Debug for PendingRunnerLaunchNonce {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("PendingRunnerLaunchNonce([REDACTED])")
    }
}

impl Debug for PendingRunnerAgentHello {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingRunnerAgentHello")
            .field("hello", &"[OWNED; NONCE REDACTED]")
            .finish()
    }
}

impl Drop for PendingRunnerAgentHello {
    fn drop(&mut self) {
        if let Some(hello) = self.hello.as_mut() {
            scrub_agent_hello(hello);
        }
    }
}

/// Checks the bounded wire shape and returns a non-cloneable secret owner.
///
/// This does not prove the launch plan, local clock, platform, process IDs,
/// peer credentials, or installed handles/file descriptors. The physical
/// bootstrap adapter must bind those facts before execution may begin.
///
/// # Errors
///
/// Size is checked before decode. The original encoded buffer and decoded
/// secrets are scrubbed on every failure path.
pub fn decode_runner_launch_handoff(
    encoded: Vec<u8>,
) -> Result<ShapeValidatedRunnerLaunchHandoff, RunnerBootstrapError> {
    let encoded = ScrubbedBytes::new(encoded);
    validate_size(
        encoded.as_slice(),
        "RunnerLaunchHandoff",
        RUNNER_LAUNCH_HANDOFF_MAX_BYTES,
    )?;
    preflight::validate_secret_safe_wire(encoded.as_slice()).map_err(|source| {
        RunnerBootstrapError::MalformedMessage {
            message: "RunnerLaunchHandoff",
            source,
        }
    })?;
    let digest = runner_launch_handoff_sha256(encoded.as_slice());
    // Own the destination before Prost starts merging. `Message::decode`
    // creates its destination internally, so a decode error would drop a
    // partially populated handoff outside our scrub guard.
    let mut handoff = ScrubbedHandoff(wire::RunnerLaunchHandoff::default());
    handoff.0.merge(encoded.as_slice()).map_err(|source| {
        RunnerBootstrapError::MalformedMessage {
            message: "RunnerLaunchHandoff",
            source,
        }
    })?;
    validate_handoff(&handoff.0)?;
    let secrets = ProtectedLaunchSecrets::take_from(&mut handoff.0, digest);
    scrub_and_clear_handoff(&mut handoff.0);
    Ok(ShapeValidatedRunnerLaunchHandoff {
        metadata: std::mem::take(&mut handoff.0),
        secrets,
        digest,
    })
}

impl ShapeValidatedRunnerLaunchHandoff {
    /// Returns shape-checked non-secret launch metadata.
    ///
    /// `launch_nonce` and every `connection_token` are empty. The raw nonce
    /// remains in a private single-use owner; only endpoint-bound token hashes
    /// are retained.
    #[must_use]
    pub const fn metadata(&self) -> &wire::RunnerLaunchHandoff {
        &self.metadata
    }

    /// SHA-256 over the exact original handoff bytes, including unknown fields.
    #[must_use]
    pub const fn original_frame_sha256(&self) -> &[u8; 32] {
        &self.digest
    }

    #[must_use]
    pub fn launch_nonce_matches(&self, candidate: &[u8]) -> bool {
        self.secrets.launch_nonce_matches(candidate)
    }

    /// Moves the raw nonce into its sole `AgentHello` commit owner.
    ///
    /// A second call returns `None`.
    pub fn take_launch_nonce(&mut self) -> Option<PendingRunnerLaunchNonce> {
        self.secrets
            .take_launch_nonce()
            .map(|bytes| PendingRunnerLaunchNonce { bytes })
    }

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

    #[cfg(test)]
    pub(super) fn encode_ready_for_test(&self) -> Result<Vec<u8>, RunnerBootstrapError> {
        let encoded = super::ready::expected_ready(&self.metadata, self.digest).encode_to_vec();
        validate_size(
            &encoded,
            "RunnerEndpointsReady",
            super::RUNNER_ENDPOINTS_READY_MAX_BYTES,
        )?;
        Ok(encoded)
    }
}

impl PendingRunnerLaunchNonce {
    /// Injects the nonce into an owned draft without exposing its bytes.
    ///
    /// # Errors
    ///
    /// Rejects a draft that already contains a nonce.
    pub fn prepare_agent_hello(
        self,
        mut draft: wire::AgentHello,
    ) -> Result<PendingRunnerAgentHello, RunnerBootstrapError> {
        if !draft.launch_nonce.is_empty() {
            return Err(RunnerBootstrapError::InvalidField {
                message: "AgentHelloDraft",
                field: "launch_nonce",
            });
        }
        draft.launch_nonce = self.bytes.take();
        Ok(PendingRunnerAgentHello { hello: Some(draft) })
    }
}

impl PendingRunnerAgentHello {
    /// Writes and commits the sole nonce-bearing `AgentHello`.
    ///
    /// Success, failure, panic, or drop scrub the only in-process plaintext
    /// owners. The transport is poisoned on an ambiguous write.
    ///
    /// # Errors
    ///
    /// Propagates bootstrap validation or transport failure.
    pub fn commit<R: Read, W: Write, F>(
        mut self,
        channel: &mut BootstrapAttemptChannel<R, W>,
        clock: F,
    ) -> Result<(), BootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        let Some(hello) = self.hello.take() else {
            return Err(BootstrapChannelError::Bootstrap(BootstrapError::Consumed));
        };
        channel.send_owned_agent_hello(hello, clock)
    }
}
