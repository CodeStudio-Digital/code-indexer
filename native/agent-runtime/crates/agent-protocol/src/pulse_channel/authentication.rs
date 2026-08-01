use std::fmt::{self, Debug, Formatter};

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::bootstrap_limits::{BOOTSTRAP_SECRET_MIN_BYTES, SESSION_TOKEN_MAX_BYTES};
use crate::wire_identity::MAX_WIRE_IDENTIFIER_BYTES;

use super::RunnerPulseError;

const KEY_DOMAIN: &[u8] = b"codestudio.agent.runner-pulse-key.v1\0";
const TAG_DOMAIN: &[u8] = b"codestudio.agent.runner-pulse-frame.v1\0";
const SHA256_BLOCK_BYTES: usize = 64;
pub(super) const AUTHENTICATION_TAG_BYTES: usize = 32;

/// Non-cloneable endpoint-bound key for one runner pulse channel.
pub struct RunnerPulseAuthenticationKey {
    derived: [u8; AUTHENTICATION_TAG_BYTES],
}

impl RunnerPulseAuthenticationKey {
    /// Consumes one raw endpoint token and immediately derives a fixed key.
    ///
    /// # Errors
    ///
    /// Rejects an invalid connection ID or token outside bootstrap bounds.
    pub fn new(connection_id: &str, mut token: Vec<u8>) -> Result<Self, RunnerPulseError> {
        let valid_connection = !connection_id.trim().is_empty()
            && connection_id.len() <= MAX_WIRE_IDENTIFIER_BYTES
            && !connection_id.contains('\0');
        let valid_token =
            (BOOTSTRAP_SECRET_MIN_BYTES..=SESSION_TOKEN_MAX_BYTES).contains(&token.len());
        if !valid_connection || !valid_token {
            token.zeroize();
            return Err(RunnerPulseError::InvalidAuthenticationKey);
        }
        let connection_length = u32::try_from(connection_id.len())
            .map_err(|_| RunnerPulseError::InvalidAuthenticationKey)?;
        let mut hasher = Sha256::new();
        hasher.update(KEY_DOMAIN);
        hasher.update(connection_length.to_be_bytes());
        hasher.update(connection_id.as_bytes());
        hasher.update(&token);
        let derived = hasher.finalize().into();
        token.zeroize();
        Ok(Self { derived })
    }

    pub(crate) fn from_validated(connection_id: &str, token: Vec<u8>) -> Self {
        Self::new(connection_id, token).expect("validated pulse endpoint key")
    }

    pub(super) fn sign(&self, payload: &[u8]) -> [u8; AUTHENTICATION_TAG_BYTES] {
        hmac_sha256(&self.derived, payload)
    }

    pub(super) fn verifies(&self, payload: &[u8], tag: &[u8]) -> bool {
        if tag.len() != AUTHENTICATION_TAG_BYTES {
            return false;
        }
        let mut expected = self.sign(payload);
        let matches = expected
            .iter()
            .zip(tag)
            .fold(0_u8, |difference, (left, right)| {
                difference | (left ^ right)
            })
            == 0;
        expected.zeroize();
        matches
    }
}

impl Debug for RunnerPulseAuthenticationKey {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter.write_str("RunnerPulseAuthenticationKey([REDACTED])")
    }
}

impl Drop for RunnerPulseAuthenticationKey {
    fn drop(&mut self) {
        self.derived.zeroize();
    }
}

fn hmac_sha256(key: &[u8; AUTHENTICATION_TAG_BYTES], payload: &[u8]) -> [u8; 32] {
    let mut inner_pad = [0x36_u8; SHA256_BLOCK_BYTES];
    let mut outer_pad = [0x5c_u8; SHA256_BLOCK_BYTES];
    for (index, byte) in key.iter().enumerate() {
        inner_pad[index] ^= byte;
        outer_pad[index] ^= byte;
    }
    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(TAG_DOMAIN);
    inner.update(
        u32::try_from(payload.len())
            .unwrap_or(u32::MAX)
            .to_be_bytes(),
    );
    inner.update(payload);
    let mut inner_digest: [u8; 32] = inner.finalize().into();
    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    let result = outer.finalize().into();
    inner_pad.zeroize();
    outer_pad.zeroize();
    inner_digest.zeroize();
    result
}
