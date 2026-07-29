use std::error::Error;
use std::fmt::{self, Display, Formatter};

use crate::framing::FramingError;
use crate::framing::asynchronous::AsyncFramingError;
use crate::management_channel::ManagementChannelError;

#[derive(Debug)]
pub enum AsyncManagementActorError {
    ActorClosed,
    CommandQueueClosed,
    CommandQueueSaturated,
    CommandQueueDeadlineElapsed,
    EventQueueBackpressure,
    DurableCommitReceiptRequired,
    PendingInboundAbandoned,
    PendingInboundDeadlineElapsed,
    OutstandingDeadlineElapsed,
    PhysicalReadDeadlineElapsed,
    PhysicalWriteDeadlineElapsed,
    PeerClosed,
    ChannelPoisoned,
    Framing(FramingError),
    Management(ManagementChannelError),
}

impl Display for AsyncManagementActorError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::ActorClosed => formatter.write_str("management actor is closed"),
            Self::CommandQueueClosed => formatter.write_str("management command queue is closed"),
            Self::CommandQueueSaturated => {
                formatter.write_str("management command admission is saturated")
            }
            Self::CommandQueueDeadlineElapsed => {
                formatter.write_str("queued management command exceeded admission deadline")
            }
            Self::EventQueueBackpressure => {
                formatter.write_str("management event queue exhausted its bounded capacity")
            }
            Self::DurableCommitReceiptRequired => {
                formatter.write_str("host ACK requires a durable commit receipt")
            }
            Self::PendingInboundAbandoned => {
                formatter.write_str("pending management inbound was abandoned")
            }
            Self::PendingInboundDeadlineElapsed => {
                formatter.write_str("pending management inbound exceeded its owner deadline")
            }
            Self::OutstandingDeadlineElapsed => {
                formatter.write_str("outstanding management frame exceeded its ACK deadline")
            }
            Self::PhysicalReadDeadlineElapsed => {
                formatter.write_str("partial management frame exceeded read deadline")
            }
            Self::PhysicalWriteDeadlineElapsed => {
                formatter.write_str("management frame exceeded write deadline")
            }
            Self::PeerClosed => formatter.write_str("management peer closed the stream"),
            Self::ChannelPoisoned => formatter.write_str("management stream is poisoned"),
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Management(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for AsyncManagementActorError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Management(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ManagementChannelError> for AsyncManagementActorError {
    fn from(value: ManagementChannelError) -> Self {
        Self::Management(value)
    }
}

impl From<FramingError> for AsyncManagementActorError {
    fn from(value: FramingError) -> Self {
        Self::Framing(value)
    }
}

impl From<AsyncFramingError> for AsyncManagementActorError {
    fn from(value: AsyncFramingError) -> Self {
        match value {
            AsyncFramingError::ChannelPoisoned => Self::ChannelPoisoned,
            AsyncFramingError::PeerClosed => Self::PeerClosed,
            AsyncFramingError::ReadDeadlineElapsed => Self::PhysicalReadDeadlineElapsed,
            AsyncFramingError::WriteDeadlineElapsed => Self::PhysicalWriteDeadlineElapsed,
            AsyncFramingError::Framing(error) => Self::Framing(error),
        }
    }
}
