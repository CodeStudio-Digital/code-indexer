use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::generated::v1 as wire;
use crate::wire_identity::WireIdentityError;

#[derive(Debug)]
pub enum FrameHeaderError {
    InvalidProtocolVersion(u32),
    InvalidIdentifier(WireIdentityError),
    ZeroFencingEpoch,
    ZeroStreamSequence,
    InvalidSentAt(i64),
    InvalidDeadline { sent_at: i64, deadline_at: i64 },
}

impl Display for FrameHeaderError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidProtocolVersion(value) => {
                write!(formatter, "frame protocol version {value} is invalid")
            }
            Self::InvalidIdentifier(error) => Display::fmt(error, formatter),
            Self::ZeroFencingEpoch => formatter.write_str("frame fencing epoch must be positive"),
            Self::ZeroStreamSequence => {
                formatter.write_str("frame stream sequence must be positive")
            }
            Self::InvalidSentAt(value) => {
                write!(formatter, "frame sent timestamp {value} is invalid")
            }
            Self::InvalidDeadline {
                sent_at,
                deadline_at,
            } => write!(
                formatter,
                "frame deadline {deadline_at} is invalid for sent timestamp {sent_at}"
            ),
        }
    }
}

impl Error for FrameHeaderError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidIdentifier(error) => Some(error),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum PayloadIdentityError {
    MissingIdentity(&'static str),
    InvalidIdentity {
        payload: &'static str,
        source: WireIdentityError,
    },
    HeaderMismatch(&'static str),
}

impl Display for PayloadIdentityError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingIdentity(payload) => {
                write!(formatter, "payload {payload} is missing attempt identity")
            }
            Self::InvalidIdentity { payload, source } => {
                write!(
                    formatter,
                    "payload {payload} has invalid identity: {source}"
                )
            }
            Self::HeaderMismatch(payload) => {
                write!(
                    formatter,
                    "payload {payload} identity does not match its frame header"
                )
            }
        }
    }
}

impl Error for PayloadIdentityError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidIdentity { source, .. } => Some(source),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub enum FrameValidationError {
    EmptyFrame,
    FrameTooLarge {
        channel: wire::TransportChannel,
        length: usize,
        maximum: usize,
    },
    MalformedFrame(prost::DecodeError),
    MissingHeader,
    InvalidHeader(FrameHeaderError),
    UnknownChannel(i32),
    UnspecifiedChannel,
    UnexpectedChannel {
        expected: wire::TransportChannel,
        actual: wire::TransportChannel,
    },
    EmptyPayload,
    InvalidDigestLength(usize),
    DigestMismatch,
    MalformedPayload(prost::DecodeError),
    MissingPayloadBody,
    PayloadIdentity(PayloadIdentityError),
    PayloadNotAllowed {
        channel: wire::TransportChannel,
        payload: &'static str,
    },
    DedicatedFrameRequired(wire::TransportChannel),
}

impl Display for FrameValidationError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyFrame => formatter.write_str("attempt frame cannot be empty"),
            Self::FrameTooLarge {
                channel,
                length,
                maximum,
            } => {
                write!(
                    formatter,
                    "{channel:?} frame has {length} bytes; hard cap is {maximum}"
                )
            }
            Self::MalformedFrame(error) => write!(formatter, "malformed frame envelope: {error}"),
            Self::MissingHeader => formatter.write_str("attempt frame header is missing"),
            Self::InvalidHeader(error) => write!(formatter, "invalid frame header: {error}"),
            Self::UnknownChannel(channel) => {
                write!(formatter, "attempt frame channel {channel} is unknown")
            }
            Self::UnspecifiedChannel => formatter.write_str("frame channel cannot be unspecified"),
            Self::UnexpectedChannel { expected, actual } => {
                write!(
                    formatter,
                    "frame arrived on {actual:?}; endpoint is {expected:?}"
                )
            }
            Self::EmptyPayload => formatter.write_str("attempt frame payload is empty"),
            Self::InvalidDigestLength(length) => {
                write!(formatter, "payload SHA-256 has {length} bytes; expected 32")
            }
            Self::DigestMismatch => formatter.write_str("payload SHA-256 does not match"),
            Self::MalformedPayload(error) => write!(formatter, "malformed frame payload: {error}"),
            Self::MissingPayloadBody => formatter.write_str("frame payload body is missing"),
            Self::PayloadIdentity(error) => Display::fmt(error, formatter),
            Self::PayloadNotAllowed { channel, payload } => {
                write!(formatter, "payload {payload} is not allowed on {channel:?}")
            }
            Self::DedicatedFrameRequired(channel) => {
                write!(
                    formatter,
                    "{channel:?} traffic requires its dedicated frame type"
                )
            }
        }
    }
}

impl Error for FrameValidationError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::MalformedFrame(error) | Self::MalformedPayload(error) => Some(error),
            Self::InvalidHeader(error) => Some(error),
            Self::PayloadIdentity(error) => Some(error),
            _ => None,
        }
    }
}
