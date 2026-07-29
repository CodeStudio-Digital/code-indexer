use std::fmt::{self, Debug, Formatter};

use prost::Message;

use crate::generated::v1 as wire;

use super::ready::{MatchedRunnerEndpointsReady, expected_ready};
use super::secrets::{ScrubbedBytes, ScrubbedHandoff};
use super::validation::{validate_handoff, validate_ready};
use super::{
    RUNNER_ENDPOINTS_READY_MAX_BYTES, RUNNER_LAUNCH_HANDOFF_MAX_BYTES, RunnerBootstrapError,
    runner_launch_handoff_sha256, validate_size,
};

/// Single-use owner of an encoded launch frame.
///
/// The frame has no reusable byte accessor and cannot accept readiness before
/// a committed transmit:
///
/// ```compile_fail
/// use agent_protocol::runner_bootstrap::PreparedRunnerLaunchHandoff;
///
/// fn replay_or_skip_write(prepared: PreparedRunnerLaunchHandoff) {
///     let _bytes = prepared.encoded();
///     let _ready = prepared.accept_ready(&[]);
/// }
/// ```
pub struct PreparedRunnerLaunchHandoff {
    encoded: ScrubbedBytes,
    expected_ready: wire::RunnerEndpointsReady,
}

pub struct AwaitingRunnerEndpointsReady {
    expected_ready: wire::RunnerEndpointsReady,
}

impl Debug for PreparedRunnerLaunchHandoff {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PreparedRunnerLaunchHandoff")
            .field("encoded", &"[REDACTED]")
            .field("expected_ready", &"[BOUND; DIGEST REDACTED]")
            .finish()
    }
}

impl Debug for AwaitingRunnerEndpointsReady {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AwaitingRunnerEndpointsReady")
            .field("expected_ready", &"[BOUND; DIGEST REDACTED]")
            .finish()
    }
}

/// Validates, encodes and seals a launch handoff for one physical send.
///
/// # Errors
///
/// Rejects malformed authority, endpoints, peers, resources or an oversized
/// encoded handoff. All input secret buffers are scrubbed on every return path.
pub fn prepare_runner_launch_handoff(
    value: wire::RunnerLaunchHandoff,
) -> Result<PreparedRunnerLaunchHandoff, RunnerBootstrapError> {
    let guarded = ScrubbedHandoff(value);
    validate_handoff(&guarded.0)?;
    let encoded = ScrubbedBytes::new(guarded.0.encode_to_vec());
    validate_size(
        encoded.as_slice(),
        "RunnerLaunchHandoff",
        RUNNER_LAUNCH_HANDOFF_MAX_BYTES,
    )?;
    let digest = runner_launch_handoff_sha256(encoded.as_slice());
    let expected_ready = expected_ready(&guarded.0, digest);
    Ok(PreparedRunnerLaunchHandoff {
        encoded,
        expected_ready,
    })
}

impl PreparedRunnerLaunchHandoff {
    /// Borrows the secret frame once, consumes its owner, and advances state
    /// only after the caller reports a committed write.
    ///
    /// The callback must not retain or replay the borrowed bytes. Returning an
    /// error drops and zeroizes the frame without creating ready authority.
    ///
    /// # Errors
    ///
    /// Returns the transport error without producing an awaiting-ready owner.
    pub(crate) fn transmit_with<E>(
        self,
        transmit: impl FnOnce(&[u8]) -> Result<(), E>,
    ) -> Result<AwaitingRunnerEndpointsReady, E> {
        transmit(self.encoded.as_slice())?;
        Ok(AwaitingRunnerEndpointsReady {
            expected_ready: self.expected_ready,
        })
    }
}

impl AwaitingRunnerEndpointsReady {
    /// Consumes the post-write owner and matches exact ready wire evidence.
    ///
    /// This proves response binding only. OS listener/peer ownership belongs to
    /// the physical bootstrap adapter and reaper.
    ///
    /// # Errors
    ///
    /// Rejects oversized, malformed or mismatched readiness evidence.
    pub fn accept_ready(
        self,
        encoded_ready: &[u8],
    ) -> Result<MatchedRunnerEndpointsReady, RunnerBootstrapError> {
        validate_size(
            encoded_ready,
            "RunnerEndpointsReady",
            RUNNER_ENDPOINTS_READY_MAX_BYTES,
        )?;
        let ready = wire::RunnerEndpointsReady::decode(encoded_ready).map_err(|source| {
            RunnerBootstrapError::MalformedMessage {
                message: "RunnerEndpointsReady",
                source,
            }
        })?;
        validate_ready(&ready, &self.expected_ready)?;
        Ok(MatchedRunnerEndpointsReady::new(ready))
    }
}
