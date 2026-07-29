use std::error::Error;
use std::fmt::{self, Display, Formatter};

use prost::Message;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use crate::generated::v1 as wire;

const PAYLOAD_HASH_DOMAIN: &[u8] = b"codestudio.agent.management-payload.v1\0";
const ENVELOPE_HASH_DOMAIN: &[u8] = b"codestudio.agent.management-envelope.v1\0";

pub const MANAGEMENT_FRAME_MAX_BYTES: usize = 64 * 1024;

#[derive(Debug)]
pub enum ManagementFrameError {
    EmptyFrame,
    FrameTooLarge { length: usize, maximum: usize },
    MalformedFrame(prost::DecodeError),
    MissingHeader,
    EmptyPayload,
    InvalidDigestLength(usize),
    DigestMismatch,
    MalformedPayload(prost::DecodeError),
    MissingPayloadBody,
}

impl Display for ManagementFrameError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => formatter.write_str("management frame cannot be empty"),
            Self::FrameTooLarge { length, maximum } => write!(
                formatter,
                "management frame has {length} bytes; hard cap is {maximum}"
            ),
            Self::MalformedFrame(error) => write!(formatter, "malformed management frame: {error}"),
            Self::MissingHeader => formatter.write_str("management frame header is missing"),
            Self::EmptyPayload => formatter.write_str("management frame payload is empty"),
            Self::InvalidDigestLength(length) => {
                write!(formatter, "payload SHA-256 has {length} bytes; expected 32")
            }
            Self::DigestMismatch => {
                formatter.write_str("management payload SHA-256 does not match")
            }
            Self::MalformedPayload(error) => {
                write!(formatter, "malformed management payload: {error}")
            }
            Self::MissingPayloadBody => formatter.write_str("management payload body is missing"),
        }
    }
}

impl Error for ManagementFrameError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MalformedFrame(error) | Self::MalformedPayload(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub struct ValidatedManagementFrame {
    pub frame: wire::ManagementFrame,
    pub payload: wire::ManagementPayload,
}

struct ScrubbedEncodedFrame(wire::ManagementFrame);

struct ScrubbedManagementPayload(wire::ManagementPayload);

impl Drop for ScrubbedEncodedFrame {
    fn drop(&mut self) {
        scrub_encoded_frame(&mut self.0);
    }
}

impl Drop for ScrubbedManagementPayload {
    fn drop(&mut self) {
        if let Some(body) = &mut self.0.body {
            crate::management_secrets::scrub_protected_body(body);
        }
    }
}

impl Drop for ValidatedManagementFrame {
    fn drop(&mut self) {
        self.frame.encoded_payload.as_mut_slice().zeroize();
        if let Some(body) = &mut self.payload.body {
            crate::management_secrets::scrub_protected_body(body);
        }
    }
}

#[must_use]
pub fn management_payload_sha256(encoded_payload: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(PAYLOAD_HASH_DOMAIN);
    hasher.update(encoded_payload);
    hasher.finalize().into()
}

#[must_use]
pub fn management_envelope_sha256(encoded_frame: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(ENVELOPE_HASH_DOMAIN);
    hasher.update(encoded_frame);
    hasher.finalize().into()
}

/// Builds a bounded management envelope from an allowed management payload.
///
/// # Errors
///
/// Rejects a payload without a known management oneof body or an envelope that
/// exceeds the immutable management-channel cap.
pub fn encode_management_frame(
    mut header: wire::ManagementFrameHeader,
    payload: &wire::ManagementPayload,
) -> Result<Vec<u8>, ManagementFrameError> {
    if payload.body.is_none() {
        return Err(ManagementFrameError::MissingPayloadBody);
    }

    let encoded_payload = payload.encode_to_vec();
    header.payload_sha256 = management_payload_sha256(&encoded_payload).to_vec();
    let mut frame = wire::ManagementFrame {
        header: Some(header),
        encoded_payload,
    };
    let mut encoded_frame = frame.encode_to_vec();
    frame.encoded_payload.as_mut_slice().zeroize();
    if let Err(error) = validate_size(&encoded_frame) {
        encoded_frame.as_mut_slice().zeroize();
        return Err(error);
    }
    Ok(encoded_frame)
}

/// Validates the original bounded envelope before decoding its opaque payload.
///
/// The digest covers the original payload bytes, including fields unknown to
/// this binary. Payload decoding occurs only after size and digest validation.
///
/// # Errors
///
/// Rejects empty, oversized, malformed, integrity-mismatched, or incomplete
/// frames. Connection authentication is a separate handshake concern.
pub fn validate_management_frame(
    encoded_frame: &[u8],
) -> Result<ValidatedManagementFrame, ManagementFrameError> {
    validate_size(encoded_frame)?;
    let mut guarded_frame = ScrubbedEncodedFrame(wire::ManagementFrame::default());
    guarded_frame
        .0
        .merge(encoded_frame)
        .map_err(ManagementFrameError::MalformedFrame)?;
    let frame = &guarded_frame.0;
    let header = frame
        .header
        .as_ref()
        .ok_or(ManagementFrameError::MissingHeader)?;
    if frame.encoded_payload.is_empty() {
        return Err(ManagementFrameError::EmptyPayload);
    }
    if header.payload_sha256.len() != 32 {
        return Err(ManagementFrameError::InvalidDigestLength(
            header.payload_sha256.len(),
        ));
    }

    let actual_digest = management_payload_sha256(&frame.encoded_payload);
    if !digest_equal(&header.payload_sha256, &actual_digest) {
        return Err(ManagementFrameError::DigestMismatch);
    }

    let mut guarded_payload = ScrubbedManagementPayload(wire::ManagementPayload::default());
    guarded_payload
        .0
        .merge(frame.encoded_payload.as_slice())
        .map_err(ManagementFrameError::MalformedPayload)?;
    if guarded_payload.0.body.is_none() {
        return Err(ManagementFrameError::MissingPayloadBody);
    }

    Ok(ValidatedManagementFrame {
        frame: std::mem::take(&mut guarded_frame.0),
        payload: std::mem::take(&mut guarded_payload.0),
    })
}

const fn validate_size(encoded_frame: &[u8]) -> Result<(), ManagementFrameError> {
    if encoded_frame.is_empty() {
        return Err(ManagementFrameError::EmptyFrame);
    }
    if encoded_frame.len() > MANAGEMENT_FRAME_MAX_BYTES {
        return Err(ManagementFrameError::FrameTooLarge {
            length: encoded_frame.len(),
            maximum: MANAGEMENT_FRAME_MAX_BYTES,
        });
    }
    Ok(())
}

fn digest_equal(expected: &[u8], actual: &[u8; 32]) -> bool {
    expected
        .iter()
        .zip(actual)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn scrub_encoded_frame(frame: &mut wire::ManagementFrame) {
    frame.encoded_payload.as_mut_slice().zeroize();
}

#[cfg(test)]
mod tests;
