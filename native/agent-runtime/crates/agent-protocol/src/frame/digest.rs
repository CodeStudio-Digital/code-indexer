use sha2::{Digest, Sha256};

const PAYLOAD_HASH_DOMAIN: &[u8] = b"codestudio.agent.frame-payload.v1\0";
const ENVELOPE_HASH_DOMAIN: &[u8] = b"codestudio.agent.frame-envelope.v1\0";

#[must_use]
pub fn frame_payload_sha256(encoded_payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PAYLOAD_HASH_DOMAIN);
    hasher.update(encoded_payload);
    hasher.finalize().into()
}

#[must_use]
pub fn frame_envelope_sha256(encoded_frame: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(ENVELOPE_HASH_DOMAIN);
    hasher.update(encoded_frame);
    hasher.finalize().into()
}

pub(super) fn digest_equal(expected: &[u8], actual: &[u8; 32]) -> bool {
    expected
        .iter()
        .zip(actual)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}
