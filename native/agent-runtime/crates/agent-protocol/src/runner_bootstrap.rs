//! Bounded, single-use supervisor-runner bootstrap authority.
//!
//! The physical transport supplies one launch frame and one ready frame. This
//! module validates the exact V1 shape, owns and scrubs launch secrets, and
//! binds readiness to the original handoff bytes. It does not claim OS
//! ownership; that receipt belongs to the platform/reaper integration.

use sha2::{Digest, Sha256};

mod error;
mod inbound;
mod outbound;
mod ready;
mod secrets;
mod transport;
mod validation;

pub use error::RunnerBootstrapError;
pub use inbound::{
    PendingRunnerAgentHello, PendingRunnerLaunchNonce, ShapeValidatedRunnerLaunchHandoff,
    decode_runner_launch_handoff,
};
pub use outbound::{
    AwaitingRunnerEndpointsReady, PreparedRunnerLaunchHandoff, prepare_runner_launch_handoff,
};
pub use ready::MatchedRunnerEndpointsReady;
pub use secrets::RunnerEndpointTokenVerifier;
#[cfg(test)]
pub(crate) use secrets::{SecretField, capture_scrub_audit};
pub(crate) use secrets::{scrub_agent_hello, scrub_host_hello};
pub use transport::{
    AwaitingPhysicalRunnerReady, ReceivedPhysicalRunnerHandoff, RunnerBootstrapReceiveFailure,
    RunnerBootstrapSendFailure, RunnerBootstrapTransportError, RunnerPhysicalBootstrapReceiver,
    RunnerReadyTransport, SupervisorPhysicalBootstrapSender,
};

const HANDOFF_HASH_DOMAIN: &[u8] = b"codestudio.agent.runner-launch-handoff.v1\0";

pub const RUNNER_BOOTSTRAP_SCHEMA_VERSION: u32 = 1;
pub const RUNNER_LAUNCH_HANDOFF_MAX_BYTES: usize = 64 * 1024;
pub const RUNNER_ENDPOINTS_READY_MAX_BYTES: usize = 4 * 1024;

#[must_use]
pub fn runner_launch_handoff_sha256(encoded_handoff: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(HANDOFF_HASH_DOMAIN);
    hasher.update(encoded_handoff);
    hasher.finalize().into()
}

pub(super) const fn validate_size(
    encoded: &[u8],
    message: &'static str,
    maximum: usize,
) -> Result<(), RunnerBootstrapError> {
    if encoded.is_empty() {
        return Err(RunnerBootstrapError::EmptyMessage(message));
    }
    if encoded.len() > maximum {
        return Err(RunnerBootstrapError::MessageTooLarge {
            message,
            length: encoded.len(),
            maximum,
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests;
