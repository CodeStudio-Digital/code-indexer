use super::super::{DirectionError, FrameValidationError};

#[derive(Debug)]
pub enum OutboundFrameError {
    SenderPoisoned,
    PendingOutboundActive,
    InvalidPendingOutbound,
    SenderIdExhausted,
    PendingTokenExhausted,
    SequenceExhausted,
    WrongBootstrapDirection,
    BootstrapAlreadySent,
    Direction(DirectionError),
    Frame(FrameValidationError),
}

impl std::fmt::Display for OutboundFrameError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SenderPoisoned => formatter.write_str("outbound authority is poisoned"),
            Self::PendingOutboundActive => formatter.write_str("an outbound frame is pending"),
            Self::InvalidPendingOutbound => {
                formatter.write_str("outbound reservation is foreign or stale")
            }
            Self::SenderIdExhausted => formatter.write_str("sender identity is exhausted"),
            Self::PendingTokenExhausted => formatter.write_str("outbound token is exhausted"),
            Self::SequenceExhausted => formatter.write_str("outbound sequence is exhausted"),
            Self::WrongBootstrapDirection => {
                formatter.write_str("Hello payload is invalid for this bootstrap direction")
            }
            Self::BootstrapAlreadySent => formatter.write_str("bootstrap Hello was already sent"),
            Self::Direction(error) => std::fmt::Display::fmt(error, formatter),
            Self::Frame(error) => std::fmt::Display::fmt(error, formatter),
        }
    }
}

impl std::error::Error for OutboundFrameError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Direction(error) => Some(error),
            Self::Frame(error) => Some(error),
            _ => None,
        }
    }
}
