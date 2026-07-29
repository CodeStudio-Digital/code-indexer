use std::error::Error;

use crate::framing::FramingError;
use crate::management_frame::ManagementFrameError;
use crate::wire_identity::WireIdentityError;

use super::ManagementDirection;

mod display;

#[derive(Debug)]
pub enum ManagementChannelError {
    InvalidReplayLimits,
    ReceiverIdExhausted,
    SenderIdExhausted,
    ChannelIdExhausted,
    InvalidProtocolVersion(u32),
    InvalidIdentifier(WireIdentityError),
    InvalidSentAt(i64),
    InvalidDeadline {
        sent_at: i64,
        deadline_at: i64,
    },
    InvalidDeadlinePolicy {
        timeout_ms: u64,
        maximum: u64,
    },
    InvalidObservedAt(i64),
    DeadlineExpired {
        deadline_at: i64,
        observed_at: i64,
    },
    ZeroStreamSequence,
    PhysicalCapMismatch {
        physical: u32,
        required: usize,
    },
    FrameTooLarge {
        length: usize,
        maximum: usize,
    },
    Frame(ManagementFrameError),
    Framing(FramingError),
    ProtocolMismatch,
    ConnectionMismatch,
    SequenceMismatch {
        expected: u64,
        actual: u64,
    },
    SequenceExhausted,
    MessageIdConflict,
    MessageIdRetired,
    IdentityCapacityExhausted,
    ReplayByteBudgetExhausted {
        required: usize,
        maximum: usize,
    },
    PayloadNotAllowed {
        direction: ManagementDirection,
        payload: &'static str,
    },
    InvalidResponseCorrelation {
        inbound: &'static str,
        outbound: &'static str,
    },
    UnexpectedReplyTo {
        payload: &'static str,
    },
    MissingReplyTo {
        payload: &'static str,
    },
    UnknownReplyTo,
    OutOfOrderResponse,
    InvalidAcknowledgement,
    InvalidResponseSemantics {
        payload: &'static str,
        field: &'static str,
    },
    InvalidManagementPayload {
        payload: &'static str,
        field: &'static str,
    },
    OutstandingCapacityExhausted {
        frames: usize,
        maximum_frames: usize,
        bytes: usize,
        maximum_bytes: usize,
    },
    PendingInboundActive,
    PendingPayloadConsumed,
    PendingTokenExhausted,
    InvalidPendingInbound,
    PendingOutboundActive,
    PendingOutboundTokenExhausted,
    InvalidPendingOutbound,
    InvalidReplayResponse {
        length: usize,
        maximum: usize,
    },
    BootstrapConsumed,
    WrongBootstrapOrder,
    WrongBootstrapPayload,
    MissingSelectedProtocol,
    InvalidSelectedProtocol,
    MissingFrameLimits,
    InvalidNegotiatedMaximum,
    InvalidContract,
    MissingSupervisorProvenance,
    InvalidProvenance(&'static str),
    MissingSupervisorLimits,
    InvalidSupervisorLimits,
    InvalidFrameLimits,
    InvalidManagementToken,
    InvalidContainment,
    InvalidLaunchNonce,
    SupervisorContractMismatch,
    SupervisorProvenanceMismatch,
    SupervisorNonceMismatch,
    InvalidFeatureNegotiation,
    InsufficientContainment,
    SeedChannelMismatch,
    UnexpectedEof,
    ChannelPoisoned,
}

impl Error for ManagementChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Frame(error) => Some(error),
            Self::Framing(error) => Some(error),
            Self::InvalidIdentifier(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ManagementFrameError> for ManagementChannelError {
    fn from(value: ManagementFrameError) -> Self {
        Self::Frame(value)
    }
}
