use prost::Message;
use zeroize::Zeroizing;

use crate::generated::v1 as wire;
use crate::identity::{AttemptIdentity, ConnectionId, MessageId};
use crate::version::ProtocolVersion;
use channel::validate_payload_channel;
use digest::digest_equal;
use header::validate_frame_header;
use payload_identity::validate_payload_identity;

mod bootstrap;
mod capacity;
mod channel;
mod data_channel;
mod digest;
mod direction;
mod error;
mod established;
mod header;
mod payload_identity;
mod receiver;
mod secrets;
mod sender;

use secrets::{ScrubbedFrameBody, ScrubbedFramePayload, ScrubbedWireFrame, scrub_body_secrets};

pub use bootstrap::{
    AsyncBootstrapAttemptChannel, AsyncBootstrapChannelError, BootstrapAgentHello,
    BootstrapAttemptChannel, BootstrapChannelError, BootstrapError, BootstrapHostHello,
    BootstrapReceiveOutcome, BootstrapReceiver, NegotiatedReceiverSeed,
};
pub use capacity::{
    CONTROL_FRAME_MAX_BYTES, DATA_FRAME_MAX_BYTES, MANAGEMENT_FRAME_MAX_BYTES,
    PULSE_FRAME_MAX_BYTES, maximum_frame_bytes,
};
pub use data_channel::{
    AsyncBoundDataAttemptChannel, AsyncPendingDataAttemptChannel, DataBindDeadlines,
    DataChannelError, DataChannelLimits, RunnerDataBindAuthority,
};
pub use digest::{frame_envelope_sha256, frame_payload_sha256};
pub use direction::{DirectionError, FrameDirection};
pub use error::{FrameHeaderError, FrameValidationError, PayloadIdentityError};
pub use established::{
    ActiveFrameReceiveOutcome, AsyncEstablishedAttemptChannel, AsyncEstablishedChannelError,
    EstablishedAttemptChannel, EstablishedChannelError,
};
pub use receiver::{
    AttemptFrameReceiver, BoundedReplayOutcome, CommittedInbound, FrameReceiveOutcome,
    InboundBinding, InboundFrameError, MAX_REPLAY_WINDOW_ENTRIES, MAX_TRACKED_MESSAGE_IDS,
    PendingInbound, ReplayedFrame,
};
pub use sender::{CommittedResponse, OutboundFrameError};

pub(super) struct ValidatedAttemptFrame {
    header: wire::FrameHeader,
    channel: wire::TransportChannel,
    body: wire::frame_payload::Body,
    protocol_version: ProtocolVersion,
    connection_id: ConnectionId,
    message_id: MessageId,
    identity: AttemptIdentity,
    payload_digest: [u8; 32],
    envelope_digest: [u8; 32],
}

pub(super) struct ValidatedOpaqueEnvelope {
    header: wire::FrameHeader,
    channel: wire::TransportChannel,
    encoded_payload: Zeroizing<Vec<u8>>,
    protocol_version: ProtocolVersion,
    connection_id: ConnectionId,
    message_id: MessageId,
    identity: AttemptIdentity,
    payload_digest: [u8; 32],
    envelope_digest: [u8; 32],
}

/// Serializes a structurally valid attempt frame under both the immutable and
/// negotiated envelope caps.
///
/// # Errors
///
/// Rejects invalid headers, payloads, channels, identities, digests, and caps.
pub fn encode_attempt_frame(
    header: wire::FrameHeader,
    channel: wire::TransportChannel,
    payload: &wire::FramePayload,
    negotiated_maximum: usize,
) -> Result<Vec<u8>, FrameValidationError> {
    let immutable_maximum =
        maximum_frame_bytes(channel).ok_or(FrameValidationError::UnspecifiedChannel)?;
    let maximum = immutable_maximum.min(negotiated_maximum);
    let encoded_payload = payload.encode_to_vec();
    let mut header = header;
    header.payload_sha256 = frame_payload_sha256(&encoded_payload).to_vec();
    let frame = ScrubbedWireFrame(wire::Frame {
        header: Some(header),
        channel: channel as i32,
        encoded_payload,
    });
    let mut encoded = Zeroizing::new(frame.0.encode_to_vec());
    let mut validated = validate_attempt_frame_with_maximum(encoded.as_slice(), channel, maximum)?;
    scrub_body_secrets(&mut validated.body);
    Ok(std::mem::take(&mut *encoded))
}

/// Validates original envelope bytes before decoding their opaque payload.
///
/// The physical endpoint supplies `expected_channel`; size is checked on the
/// original bytes so unknown envelope fields cannot disappear before the cap.
///
/// # Errors
///
/// Rejects missing or cross-wired metadata, invalid authority, empty/oversized
/// payloads, invalid digests, malformed payloads, and forbidden payload kinds.
#[cfg(test)]
pub(crate) fn validate_attempt_frame(
    encoded_frame: &[u8],
    expected_channel: wire::TransportChannel,
) -> Result<ValidatedAttemptFrame, FrameValidationError> {
    let maximum =
        maximum_frame_bytes(expected_channel).ok_or(FrameValidationError::UnspecifiedChannel)?;
    validate_attempt_frame_with_maximum(encoded_frame, expected_channel, maximum)
}

fn validate_attempt_frame_with_maximum(
    encoded_frame: &[u8],
    expected_channel: wire::TransportChannel,
    maximum: usize,
) -> Result<ValidatedAttemptFrame, FrameValidationError> {
    decode_attempt_payload(validate_opaque_envelope(
        encoded_frame,
        expected_channel,
        maximum,
    )?)
}

fn validate_opaque_envelope(
    encoded_frame: &[u8],
    expected_channel: wire::TransportChannel,
    maximum: usize,
) -> Result<ValidatedOpaqueEnvelope, FrameValidationError> {
    let immutable_maximum =
        maximum_frame_bytes(expected_channel).ok_or(FrameValidationError::UnspecifiedChannel)?;
    let maximum = maximum.min(immutable_maximum);
    if encoded_frame.is_empty() {
        return Err(FrameValidationError::EmptyFrame);
    }
    if encoded_frame.len() > maximum {
        return Err(FrameValidationError::FrameTooLarge {
            channel: expected_channel,
            length: encoded_frame.len(),
            maximum,
        });
    }
    let envelope_digest = frame_envelope_sha256(encoded_frame);
    let mut frame = ScrubbedWireFrame(
        wire::Frame::decode(encoded_frame).map_err(FrameValidationError::MalformedFrame)?,
    );
    let channel = wire::TransportChannel::try_from(frame.0.channel)
        .map_err(|_| FrameValidationError::UnknownChannel(frame.0.channel))?;
    if channel == wire::TransportChannel::Unspecified
        || expected_channel == wire::TransportChannel::Unspecified
    {
        return Err(FrameValidationError::UnspecifiedChannel);
    }
    if channel != expected_channel {
        return Err(FrameValidationError::UnexpectedChannel {
            expected: expected_channel,
            actual: channel,
        });
    }
    let header = validate_frame_header(
        frame
            .0
            .header
            .take()
            .ok_or(FrameValidationError::MissingHeader)?,
    )
    .map_err(FrameValidationError::InvalidHeader)?;
    if frame.0.encoded_payload.is_empty() {
        return Err(FrameValidationError::EmptyPayload);
    }
    if header.wire.payload_sha256.len() != 32 {
        return Err(FrameValidationError::InvalidDigestLength(
            header.wire.payload_sha256.len(),
        ));
    }
    let payload_digest = frame_payload_sha256(&frame.0.encoded_payload);
    if !digest_equal(&header.wire.payload_sha256, &payload_digest) {
        return Err(FrameValidationError::DigestMismatch);
    }
    Ok(ValidatedOpaqueEnvelope {
        header: header.wire,
        channel,
        encoded_payload: Zeroizing::new(std::mem::take(&mut frame.0.encoded_payload)),
        protocol_version: header.protocol_version,
        connection_id: header.connection_id,
        message_id: header.message_id,
        identity: header.identity,
        payload_digest,
        envelope_digest,
    })
}

fn decode_attempt_payload(
    opaque: ValidatedOpaqueEnvelope,
) -> Result<ValidatedAttemptFrame, FrameValidationError> {
    let mut payload = ScrubbedFramePayload::default();
    payload
        .0
        .merge(opaque.encoded_payload.as_slice())
        .map_err(FrameValidationError::MalformedPayload)?;
    let mut body = payload
        .0
        .body
        .take()
        .ok_or(FrameValidationError::MissingPayloadBody)?;
    if let Err(error) = validate_payload_channel(opaque.channel, &body) {
        scrub_body_secrets(&mut body);
        return Err(error);
    }
    if let Err(error) = validate_payload_identity(&opaque.identity, &body) {
        scrub_body_secrets(&mut body);
        return Err(FrameValidationError::PayloadIdentity(error));
    }
    Ok(ValidatedAttemptFrame {
        header: opaque.header,
        channel: opaque.channel,
        body,
        protocol_version: opaque.protocol_version,
        connection_id: opaque.connection_id,
        message_id: opaque.message_id,
        identity: opaque.identity,
        payload_digest: opaque.payload_digest,
        envelope_digest: opaque.envelope_digest,
    })
}

#[cfg(test)]
mod tests;
