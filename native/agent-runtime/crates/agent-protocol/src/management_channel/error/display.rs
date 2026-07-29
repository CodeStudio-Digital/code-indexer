use std::fmt::{self, Display, Formatter};

use super::ManagementChannelError;

mod policy;

use policy::format_policy_error;

impl Display for ManagementChannelError {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        match self {
            error @ (Self::InvalidReplayLimits
            | Self::ReceiverIdExhausted
            | Self::SenderIdExhausted
            | Self::ChannelIdExhausted
            | Self::SequenceExhausted
            | Self::MessageIdConflict
            | Self::MessageIdRetired
            | Self::IdentityCapacityExhausted
            | Self::ReplayByteBudgetExhausted { .. }
            | Self::PendingInboundActive
            | Self::PendingPayloadConsumed
            | Self::PendingTokenExhausted
            | Self::InvalidPendingInbound
            | Self::PendingOutboundActive
            | Self::PendingOutboundTokenExhausted
            | Self::InvalidPendingOutbound
            | Self::InvalidReplayResponse { .. }) => format_authority_error(error, f),
            Self::InvalidProtocolVersion(value) => write!(f, "invalid protocol version {value}"),
            Self::InvalidIdentifier(error) => Display::fmt(error, f),
            Self::InvalidSentAt(value) => write!(f, "invalid sent timestamp {value}"),
            Self::InvalidDeadline {
                sent_at,
                deadline_at,
            } => write!(
                f,
                "deadline {deadline_at} is not after sent timestamp {sent_at}"
            ),
            Self::InvalidDeadlinePolicy {
                timeout_ms,
                maximum,
            } => write!(
                f,
                "management deadline timeout {timeout_ms} exceeds bounded maximum {maximum}"
            ),
            Self::InvalidObservedAt(value) => write!(f, "invalid observed timestamp {value}"),
            Self::DeadlineExpired {
                deadline_at,
                observed_at,
            } => write!(f, "deadline {deadline_at} expired at {observed_at}"),
            Self::ZeroStreamSequence => f.write_str("stream sequence must be positive"),
            Self::PhysicalCapMismatch { physical, required } => {
                write!(
                    f,
                    "physical cap {physical} does not equal required cap {required}"
                )
            }
            Self::FrameTooLarge { length, maximum } => {
                write!(
                    f,
                    "management frame has {length} bytes; maximum is {maximum}"
                )
            }
            Self::Frame(error) => Display::fmt(error, f),
            Self::Framing(error) => Display::fmt(error, f),
            Self::ProtocolMismatch => f.write_str("management protocol does not match connection"),
            Self::ConnectionMismatch => f.write_str("management connection ID does not match"),
            Self::SequenceMismatch { expected, actual } => {
                write!(f, "expected stream sequence {expected}, got {actual}")
            }
            Self::PayloadNotAllowed { direction, payload } => {
                write!(f, "{payload} is forbidden for {direction:?}")
            }
            error @ (Self::InvalidResponseCorrelation { .. }
            | Self::UnexpectedReplyTo { .. }
            | Self::MissingReplyTo { .. }
            | Self::UnknownReplyTo
            | Self::OutOfOrderResponse
            | Self::InvalidAcknowledgement
            | Self::InvalidResponseSemantics { .. }
            | Self::InvalidManagementPayload { .. }
            | Self::OutstandingCapacityExhausted { .. }) => format_transaction_error(error, f),
            Self::BootstrapConsumed => f.write_str("management bootstrap is already consumed"),
            Self::WrongBootstrapOrder => f.write_str("management Hello order is invalid"),
            Self::WrongBootstrapPayload => f.write_str("payload is forbidden during bootstrap"),
            Self::MissingSelectedProtocol => f.write_str("selected protocol is missing"),
            Self::InvalidSelectedProtocol => f.write_str("selected protocol is invalid"),
            Self::MissingFrameLimits => f.write_str("management frame limits are missing"),
            Self::InvalidNegotiatedMaximum => f.write_str("negotiated frame maximum is invalid"),
            error @ (Self::InvalidContract
            | Self::MissingSupervisorProvenance
            | Self::InvalidProvenance(_)
            | Self::MissingSupervisorLimits
            | Self::InvalidSupervisorLimits
            | Self::InvalidFrameLimits
            | Self::InvalidManagementToken
            | Self::InvalidContainment
            | Self::InvalidLaunchNonce
            | Self::SupervisorContractMismatch
            | Self::SupervisorProvenanceMismatch
            | Self::SupervisorNonceMismatch
            | Self::InvalidFeatureNegotiation
            | Self::InsufficientContainment) => format_policy_error(error, f),
            Self::SeedChannelMismatch => f.write_str("bootstrap seed belongs to another channel"),
            Self::UnexpectedEof => f.write_str("management transport ended unexpectedly"),
            Self::ChannelPoisoned => f.write_str("management channel is permanently poisoned"),
        }
    }
}

fn format_transaction_error(error: &ManagementChannelError, f: &mut Formatter<'_>) -> fmt::Result {
    match error {
        ManagementChannelError::InvalidResponseCorrelation { inbound, outbound } => {
            write!(f, "{outbound} is not a valid response to {inbound}")
        }
        ManagementChannelError::UnexpectedReplyTo { payload } => {
            write!(f, "new management payload {payload} cannot have reply_to")
        }
        ManagementChannelError::MissingReplyTo { payload } => {
            write!(f, "management response {payload} requires reply_to")
        }
        ManagementChannelError::UnknownReplyTo => {
            f.write_str("management response references no outstanding message")
        }
        ManagementChannelError::OutOfOrderResponse => {
            f.write_str("management response is out of outstanding FIFO order")
        }
        ManagementChannelError::InvalidAcknowledgement => {
            f.write_str("management ACK does not match the outstanding message")
        }
        ManagementChannelError::InvalidResponseSemantics { payload, field } => {
            write!(f, "{payload} does not match request field {field}")
        }
        ManagementChannelError::InvalidManagementPayload { payload, field } => {
            write!(f, "{payload} field {field} is invalid")
        }
        ManagementChannelError::OutstandingCapacityExhausted {
            frames,
            maximum_frames,
            bytes,
            maximum_bytes,
        } => write!(
            f,
            "outstanding management budget needs {frames}/{bytes}; maximum is {maximum_frames}/{maximum_bytes}"
        ),
        _ => unreachable!("only management transaction errors are delegated"),
    }
}

fn format_authority_error(error: &ManagementChannelError, f: &mut Formatter<'_>) -> fmt::Result {
    match error {
        ManagementChannelError::InvalidReplayLimits => {
            f.write_str("management replay limits are invalid")
        }
        ManagementChannelError::ReceiverIdExhausted => {
            f.write_str("management receiver IDs are exhausted")
        }
        ManagementChannelError::SenderIdExhausted => {
            f.write_str("management sender IDs are exhausted")
        }
        ManagementChannelError::ChannelIdExhausted => {
            f.write_str("management channel IDs are exhausted")
        }
        ManagementChannelError::SequenceExhausted => {
            f.write_str("management stream sequence is exhausted")
        }
        ManagementChannelError::MessageIdConflict => {
            f.write_str("message ID was reused with different bytes")
        }
        ManagementChannelError::MessageIdRetired => {
            f.write_str("message ID is outside the replay window")
        }
        ManagementChannelError::IdentityCapacityExhausted => {
            f.write_str("message identity capacity is exhausted")
        }
        ManagementChannelError::ReplayByteBudgetExhausted { required, maximum } => {
            write!(f, "replay needs {required} bytes; maximum is {maximum}")
        }
        ManagementChannelError::PendingInboundActive => {
            f.write_str("an inbound transaction is already pending")
        }
        ManagementChannelError::PendingPayloadConsumed => {
            f.write_str("pending payload was already consumed")
        }
        ManagementChannelError::PendingTokenExhausted => {
            f.write_str("pending inbound tokens are exhausted")
        }
        ManagementChannelError::InvalidPendingInbound => {
            f.write_str("pending inbound belongs to another channel")
        }
        ManagementChannelError::PendingOutboundActive => {
            f.write_str("an outbound transaction is already pending")
        }
        ManagementChannelError::PendingOutboundTokenExhausted => {
            f.write_str("pending outbound tokens are exhausted")
        }
        ManagementChannelError::InvalidPendingOutbound => {
            f.write_str("pending outbound authority is invalid")
        }
        ManagementChannelError::InvalidReplayResponse { length, maximum } => {
            write!(
                f,
                "replay response has {length} bytes; maximum is {maximum}"
            )
        }
        _ => unreachable!("only management authority errors are delegated"),
    }
}
