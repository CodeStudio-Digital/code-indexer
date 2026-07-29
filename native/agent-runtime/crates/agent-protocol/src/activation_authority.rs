//! Typed commitment for authority that will arrive in `ActivateAttempt`.

use std::error::Error;
use std::fmt::{self, Display, Formatter};

use sha2::{Digest, Sha256};

use crate::generated::v1 as wire;

pub const ACTIVATION_NONCE_SHA256_BYTES: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivationAuthoritySeal {
    agent_run_version: u64,
    attempt_version: u64,
    activation_nonce_sha256: [u8; ACTIVATION_NONCE_SHA256_BYTES],
}

impl ActivationAuthoritySeal {
    #[must_use]
    pub const fn agent_run_version(self) -> u64 {
        self.agent_run_version
    }

    #[must_use]
    pub const fn attempt_version(self) -> u64 {
        self.attempt_version
    }

    #[must_use]
    pub const fn activation_nonce_sha256(self) -> [u8; ACTIVATION_NONCE_SHA256_BYTES] {
        self.activation_nonce_sha256
    }

    #[must_use]
    pub fn matches(self, agent_run_version: u64, attempt_version: u64, raw_nonce: &[u8]) -> bool {
        if agent_run_version != self.agent_run_version || attempt_version != self.attempt_version {
            return false;
        }
        let actual = activation_nonce_sha256(raw_nonce);
        constant_time_equal(&self.activation_nonce_sha256, &actual)
    }

    #[cfg(test)]
    #[must_use]
    pub fn from_raw_nonce(agent_run_version: u64, attempt_version: u64, raw_nonce: &[u8]) -> Self {
        Self {
            agent_run_version,
            attempt_version,
            activation_nonce_sha256: activation_nonce_sha256(raw_nonce),
        }
    }
}

impl TryFrom<&wire::ActivationAuthoritySeal> for ActivationAuthoritySeal {
    type Error = ActivationAuthoritySealError;

    fn try_from(value: &wire::ActivationAuthoritySeal) -> Result<Self, Self::Error> {
        if value.agent_run_version == 0 {
            return Err(ActivationAuthoritySealError::ZeroAgentRunVersion);
        }
        if value.attempt_version == 0 {
            return Err(ActivationAuthoritySealError::ZeroAttemptVersion);
        }
        let activation_nonce_sha256 = value
            .activation_nonce_sha256
            .as_slice()
            .try_into()
            .map_err(|_| {
                ActivationAuthoritySealError::InvalidNonceDigestLength(
                    value.activation_nonce_sha256.len(),
                )
            })?;
        Ok(Self {
            agent_run_version: value.agent_run_version,
            attempt_version: value.attempt_version,
            activation_nonce_sha256,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivationAuthoritySealError {
    ZeroAgentRunVersion,
    ZeroAttemptVersion,
    InvalidNonceDigestLength(usize),
}

impl Display for ActivationAuthoritySealError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ZeroAgentRunVersion => {
                formatter.write_str("activation agent run version must be positive")
            }
            Self::ZeroAttemptVersion => {
                formatter.write_str("activation attempt version must be positive")
            }
            Self::InvalidNonceDigestLength(length) => write!(
                formatter,
                "activation nonce SHA-256 has {length} bytes; expected {ACTIVATION_NONCE_SHA256_BYTES}"
            ),
        }
    }
}

impl Error for ActivationAuthoritySealError {}

#[must_use]
pub fn activation_nonce_sha256(raw_nonce: &[u8]) -> [u8; ACTIVATION_NONCE_SHA256_BYTES] {
    Sha256::digest(raw_nonce).into()
}

fn constant_time_equal(
    left: &[u8; ACTIVATION_NONCE_SHA256_BYTES],
    right: &[u8; ACTIVATION_NONCE_SHA256_BYTES],
) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seal_matches_only_exact_versions_and_raw_nonce() {
        let seal = ActivationAuthoritySeal::from_raw_nonce(8, 5, b"activation-nonce");

        assert!(seal.matches(8, 5, b"activation-nonce"));
        assert!(!seal.matches(9, 5, b"activation-nonce"));
        assert!(!seal.matches(8, 6, b"activation-nonce"));
        assert!(!seal.matches(8, 5, b"activation-noncf"));
    }

    #[test]
    fn wire_seal_requires_versions_and_exact_sha256_length() {
        let valid = wire::ActivationAuthoritySeal {
            agent_run_version: 8,
            attempt_version: 5,
            activation_nonce_sha256: vec![7; ACTIVATION_NONCE_SHA256_BYTES],
        };
        assert!(ActivationAuthoritySeal::try_from(&valid).is_ok());

        let mut invalid = valid.clone();
        invalid.agent_run_version = 0;
        assert_eq!(
            ActivationAuthoritySeal::try_from(&invalid),
            Err(ActivationAuthoritySealError::ZeroAgentRunVersion)
        );

        invalid = valid;
        invalid.activation_nonce_sha256.truncate(31);
        assert_eq!(
            ActivationAuthoritySeal::try_from(&invalid),
            Err(ActivationAuthoritySealError::InvalidNonceDigestLength(31))
        );
    }
}
