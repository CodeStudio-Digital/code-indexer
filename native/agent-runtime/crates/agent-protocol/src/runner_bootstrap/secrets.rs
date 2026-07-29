use std::fmt::{self, Debug, Formatter};

use crate::generated::v1 as wire;
use sha2::{Digest, Sha256};
use zeroize::{Zeroize, Zeroizing};

mod scrub;
#[cfg(test)]
mod tests;

#[cfg(test)]
pub use scrub::{ScrubAudit, SecretField, capture_scrub_audit};
pub(super) use scrub::{ScrubbedHandoff, scrub_and_clear_handoff};
pub use scrub::{scrub_agent_hello, scrub_host_hello};

const TOKEN_HASH_DOMAIN: &[u8] = b"codestudio.agent.runner-connection-token.v1\0";

pub(super) struct ScrubbedBytes(Zeroizing<Vec<u8>>);

impl ScrubbedBytes {
    pub(super) fn new(value: Vec<u8>) -> Self {
        Self(Zeroizing::new(value))
    }

    pub(super) fn as_slice(&self) -> &[u8] {
        self.0.as_slice()
    }

    pub(super) fn take(mut self) -> Vec<u8> {
        std::mem::take(&mut *self.0)
    }
}

/// Endpoint-bound verifier that never exposes either the token or its digest.
///
/// This authority is deliberately non-cloneable:
///
/// ```compile_fail
/// use agent_protocol::runner_bootstrap::RunnerEndpointTokenVerifier;
///
/// fn require_clone<T: Clone>() {}
/// require_clone::<RunnerEndpointTokenVerifier>();
/// ```
pub struct RunnerEndpointTokenVerifier {
    kind: wire::AttemptEndpointKind,
    connection_id: String,
    handoff_digest: [u8; 32],
    digest: [u8; 32],
}

impl Debug for RunnerEndpointTokenVerifier {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RunnerEndpointTokenVerifier")
            .field("kind", &self.kind)
            .field("connection_id", &self.connection_id)
            .field("handoff_digest", &"[REDACTED]")
            .field("digest", &"[REDACTED]")
            .finish()
    }
}

impl RunnerEndpointTokenVerifier {
    fn new(endpoint: &wire::RunnerLaunchEndpoint, handoff_digest: [u8; 32]) -> Self {
        let kind = wire::AttemptEndpointKind::try_from(endpoint.kind)
            .expect("shape validation precedes secret protection");
        Self {
            kind,
            connection_id: endpoint.connection_id.clone(),
            handoff_digest,
            digest: token_sha256(
                endpoint.kind,
                &endpoint.connection_id,
                &endpoint.connection_token,
            ),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_for_test(
        kind: wire::AttemptEndpointKind,
        connection_id: impl Into<String>,
        token: &[u8],
        handoff_digest: [u8; 32],
    ) -> Self {
        let connection_id = connection_id.into();
        Self {
            kind,
            digest: token_sha256(kind as i32, &connection_id, token),
            connection_id,
            handoff_digest,
        }
    }

    #[must_use]
    pub fn is_bound_to(
        &self,
        handoff_digest: &[u8; 32],
        kind: wire::AttemptEndpointKind,
        connection_id: &str,
    ) -> bool {
        self.kind == kind
            && self.connection_id == connection_id
            && digest_equal(&self.handoff_digest, handoff_digest)
    }

    #[must_use]
    pub fn matches(&self, candidate: &[u8]) -> bool {
        let mut actual = token_sha256(self.kind as i32, &self.connection_id, candidate);
        let matches = digest_equal(&self.digest, &actual);
        actual.zeroize();
        matches
    }
}

impl Drop for RunnerEndpointTokenVerifier {
    fn drop(&mut self) {
        self.handoff_digest.zeroize();
        self.digest.zeroize();
    }
}

pub(super) struct ProtectedLaunchSecrets {
    launch_nonce: Option<ScrubbedBytes>,
    endpoint_token_verifiers: Vec<Option<RunnerEndpointTokenVerifier>>,
}

impl ProtectedLaunchSecrets {
    pub(super) fn take_from(
        value: &mut wire::RunnerLaunchHandoff,
        handoff_digest: [u8; 32],
    ) -> Self {
        let launch_nonce = ScrubbedBytes::new(std::mem::take(&mut value.launch_nonce));
        let endpoint_token_verifiers = value
            .endpoints
            .iter()
            .map(|endpoint| Some(RunnerEndpointTokenVerifier::new(endpoint, handoff_digest)))
            .collect();
        for endpoint in &mut value.endpoints {
            scrub::scrub_and_clear_endpoint(endpoint);
        }
        Self {
            launch_nonce: Some(launch_nonce),
            endpoint_token_verifiers,
        }
    }

    pub(super) fn launch_nonce_matches(&self, candidate: &[u8]) -> bool {
        self.launch_nonce
            .as_ref()
            .is_some_and(|expected| secret_equal(expected.as_slice(), candidate))
    }

    pub(super) const fn take_launch_nonce(&mut self) -> Option<ScrubbedBytes> {
        self.launch_nonce.take()
    }

    pub(super) fn take_endpoint_token_verifier(
        &mut self,
        index: usize,
    ) -> Option<RunnerEndpointTokenVerifier> {
        self.endpoint_token_verifiers.get_mut(index)?.take()
    }
}

fn token_sha256(kind: i32, connection_id: &str, token: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(TOKEN_HASH_DOMAIN);
    hasher.update(kind.to_be_bytes());
    hasher.update(
        u32::try_from(connection_id.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    hasher.update(connection_id.as_bytes());
    hasher.update(token);
    hasher.finalize().into()
}

fn secret_equal(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0
}

fn digest_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    secret_equal(left, right)
}
