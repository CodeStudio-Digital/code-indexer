use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::generated::v1 as wire;

use super::super::{DirectionError, FrameValidationError};

#[derive(Debug)]
pub enum InboundFrameError {
    ReceiverPoisoned,
    PendingInboundActive,
    PendingPayloadConsumed,
    InvalidPending,
    InvalidReplayWindow,
    ReplayWindowTooLarge { requested: usize, maximum: usize },
    InvalidTotalIdentityCapacity,
    InvalidReplayByteBudget,
    IdentityCapacityExhausted,
    ReplayByteBudgetExhausted { required: usize, maximum: usize },
    ReceiverIdExhausted,
    PendingTokenExhausted,
    UnsupportedChannel(wire::TransportChannel),
    InvalidObservedAt(i64),
    DeadlineExpired { deadline_at: i64, observed_at: i64 },
    Frame(FrameValidationError),
    Direction(DirectionError),
    ProtocolMismatch,
    ConnectionMismatch,
    AttemptIdentityMismatch,
    MessageIdConflict,
    MessageIdRetired,
    SequenceMismatch { expected: u64, actual: u64 },
    SequenceExhausted,
    InvalidReplayResponse { length: usize, maximum: usize },
    InvalidReplayReservation,
}

impl Display for InboundFrameError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ReceiverPoisoned => formatter.write_str("attempt frame receiver is poisoned"),
            Self::PendingInboundActive => formatter.write_str("an inbound frame is still pending"),
            Self::PendingPayloadConsumed => {
                formatter.write_str("pending payload was already consumed")
            }
            Self::InvalidPending => formatter.write_str("pending frame is foreign or stale"),
            Self::InvalidReplayWindow => formatter.write_str("replay window must be non-zero"),
            Self::ReplayWindowTooLarge { requested, maximum } => {
                write!(
                    formatter,
                    "replay window {requested} exceeds hard cap {maximum}"
                )
            }
            Self::InvalidTotalIdentityCapacity => {
                formatter.write_str("total message identity capacity is invalid")
            }
            Self::InvalidReplayByteBudget => {
                formatter.write_str("maximum replay bytes must be non-zero")
            }
            Self::IdentityCapacityExhausted => {
                formatter.write_str("total message identity capacity is exhausted")
            }
            Self::ReplayByteBudgetExhausted { required, maximum } => write!(
                formatter,
                "replay buffers require {required} bytes but budget is {maximum}"
            ),
            Self::ReceiverIdExhausted => formatter.write_str("receiver identity is exhausted"),
            Self::PendingTokenExhausted => formatter.write_str("pending token is exhausted"),
            Self::UnsupportedChannel(channel) => {
                write!(formatter, "receiver channel {channel:?} is unsupported")
            }
            Self::InvalidObservedAt(value) => {
                write!(formatter, "observed timestamp {value} is invalid")
            }
            Self::DeadlineExpired {
                deadline_at,
                observed_at,
            } => write!(
                formatter,
                "frame deadline {deadline_at} expired before observation {observed_at}"
            ),
            Self::Frame(error) => Display::fmt(error, formatter),
            Self::Direction(error) => Display::fmt(error, formatter),
            Self::ProtocolMismatch => {
                formatter.write_str("frame protocol does not match connection")
            }
            Self::ConnectionMismatch => formatter.write_str("frame connection ID does not match"),
            Self::AttemptIdentityMismatch => {
                formatter.write_str("frame attempt authority is not current")
            }
            Self::MessageIdConflict => {
                formatter.write_str("message ID was reused with different envelope bytes")
            }
            Self::MessageIdRetired => formatter.write_str("message ID is retired and cannot recur"),
            Self::SequenceMismatch { expected, actual } => {
                write!(
                    formatter,
                    "stream sequence {actual} does not equal expected {expected}"
                )
            }
            Self::SequenceExhausted => formatter.write_str("stream sequence is exhausted"),
            Self::InvalidReplayResponse { length, maximum } => {
                write!(
                    formatter,
                    "replay response length {length} exceeds bound {maximum}"
                )
            }
            Self::InvalidReplayReservation => {
                formatter.write_str("replay metadata is foreign or stale")
            }
        }
    }
}

impl Error for InboundFrameError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Frame(error) => Some(error),
            Self::Direction(error) => Some(error),
            _ => None,
        }
    }
}

impl From<FrameValidationError> for InboundFrameError {
    fn from(value: FrameValidationError) -> Self {
        Self::Frame(value)
    }
}
