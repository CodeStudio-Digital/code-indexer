use std::fmt::{self, Debug, Formatter};

use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::bootstrap_limits::{
    BOOTSTRAP_SECRET_MIN_BYTES, LAUNCH_NONCE_MAX_BYTES, SESSION_TOKEN_MAX_BYTES,
};
use crate::management_channel::ManagementChannelError;

const TOKEN_DOMAIN: &[u8] = b"codestudio.agent.management-token.v1\0";
const NONCE_DOMAIN: &[u8] = b"codestudio.agent.supervisor-nonce.v1\0";

#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::management_channel) struct SecretDigest([u8; 32]);

impl Debug for SecretDigest {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.write_str("SecretDigest([REDACTED])")
    }
}

impl SecretDigest {
    pub(super) fn matches_token(self, candidate: &[u8]) -> bool {
        valid_length(candidate.len(), SESSION_TOKEN_MAX_BYTES)
            && constant_time_equal(&self.0, &digest(TOKEN_DOMAIN, candidate))
    }

    pub(super) fn matches_nonce(self, candidate: &[u8]) -> bool {
        valid_length(candidate.len(), LAUNCH_NONCE_MAX_BYTES)
            && constant_time_equal(&self.0, &digest(NONCE_DOMAIN, candidate))
    }
}

pub fn seal_token(mut secret: Vec<u8>) -> Result<SecretDigest, ManagementChannelError> {
    let valid = valid_length(secret.len(), SESSION_TOKEN_MAX_BYTES);
    let sealed = digest(TOKEN_DOMAIN, &secret);
    secret.as_mut_slice().zeroize();
    if !valid {
        return Err(ManagementChannelError::InvalidManagementToken);
    }
    Ok(SecretDigest(sealed))
}

pub fn seal_nonce(mut secret: Vec<u8>) -> Result<SecretDigest, ManagementChannelError> {
    let valid = valid_length(secret.len(), LAUNCH_NONCE_MAX_BYTES);
    let sealed = digest(NONCE_DOMAIN, &secret);
    secret.as_mut_slice().zeroize();
    if !valid {
        return Err(ManagementChannelError::InvalidLaunchNonce);
    }
    Ok(SecretDigest(sealed))
}

fn digest(domain: &[u8], secret: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(secret);
    hasher.finalize().into()
}

const fn valid_length(length: usize, maximum: usize) -> bool {
    length >= BOOTSTRAP_SECRET_MIN_BYTES && length <= maximum
}

fn constant_time_equal(left: &[u8; 32], right: &[u8; 32]) -> bool {
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use super::{seal_nonce, seal_token};
    use crate::management_channel::ManagementChannelError;

    #[test]
    fn shared_bootstrap_secret_bounds_are_enforced() {
        assert!(seal_token(vec![1; 512]).is_ok());
        assert!(matches!(
            seal_token(vec![1; 513]),
            Err(ManagementChannelError::InvalidManagementToken)
        ));
        assert!(seal_nonce(vec![1; 256]).is_ok());
        assert!(matches!(
            seal_nonce(vec![1; 257]),
            Err(ManagementChannelError::InvalidLaunchNonce)
        ));
    }
}
