use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::wire_identity::WireIdentityError;

use super::super::FrameValidationError;

#[derive(Debug)]
pub enum BootstrapError {
    Consumed,
    InvalidHardCap,
    ChannelIdExhausted,
    InvalidExpectedIdentity(WireIdentityError),
    InvalidSelectedConnection(WireIdentityError),
    AuthorityMismatch,
    InvalidObservedAt(i64),
    DeadlineExpired { deadline_at: i64, observed_at: i64 },
    WrongSequence(u64),
    WrongPayload,
    Frame(FrameValidationError),
    ProtocolMismatch,
    ConnectionMismatch,
    MissingSelectedProtocol,
    InvalidSelectedProtocol,
    MissingFrameLimits,
    InvalidNegotiatedMaximum,
}

impl Display for BootstrapError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::Consumed => formatter.write_str("bootstrap receiver is already consumed"),
            Self::InvalidHardCap => formatter.write_str("bootstrap hard cap is invalid"),
            Self::ChannelIdExhausted => {
                formatter.write_str("bootstrap channel identity is exhausted")
            }
            Self::InvalidExpectedIdentity(error) => {
                write!(formatter, "bootstrap identity is invalid: {error}")
            }
            Self::InvalidSelectedConnection(error) => {
                write!(formatter, "HostHello connection ID is invalid: {error}")
            }
            Self::AuthorityMismatch => {
                formatter.write_str("bootstrap attempt authority does not match launch")
            }
            Self::InvalidObservedAt(value) => {
                write!(formatter, "bootstrap observed timestamp {value} is invalid")
            }
            Self::DeadlineExpired {
                deadline_at,
                observed_at,
            } => write!(
                formatter,
                "bootstrap deadline {deadline_at} expired at {observed_at}"
            ),
            Self::WrongSequence(sequence) => {
                write!(
                    formatter,
                    "bootstrap stream sequence must be 1, got {sequence}"
                )
            }
            Self::WrongPayload => formatter.write_str("payload is forbidden during bootstrap"),
            Self::Frame(error) => Display::fmt(error, formatter),
            Self::ProtocolMismatch => {
                formatter.write_str("HostHello protocol does not match frame header")
            }
            Self::ConnectionMismatch => {
                formatter.write_str("HostHello connection does not match frame header")
            }
            Self::MissingSelectedProtocol => {
                formatter.write_str("HostHello selected protocol is missing")
            }
            Self::InvalidSelectedProtocol => {
                formatter.write_str("HostHello selected protocol is invalid")
            }
            Self::MissingFrameLimits => formatter.write_str("HostHello frame limits are missing"),
            Self::InvalidNegotiatedMaximum => {
                formatter.write_str("HostHello negotiated frame maximum is invalid")
            }
        }
    }
}

impl Error for BootstrapError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Frame(error) => Some(error),
            Self::InvalidExpectedIdentity(error) | Self::InvalidSelectedConnection(error) => {
                Some(error)
            }
            _ => None,
        }
    }
}

impl From<FrameValidationError> for BootstrapError {
    fn from(value: FrameValidationError) -> Self {
        Self::Frame(value)
    }
}
