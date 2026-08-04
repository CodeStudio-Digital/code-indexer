use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{Read, Write};

use crate::framing::{DelimitedFrameChannel, FramingError};

use super::sender::OutboundHeaderAuthority;
use super::{
    AttemptFrameReceiver, FrameReceiveOutcome, InboundFrameError, OutboundFrameError,
    PendingInbound,
};

mod asynchronous;
mod outbound;

pub use asynchronous::{
    ActiveFrameReceiveOutcome, AsyncEstablishedAttemptChannel, AsyncEstablishedChannelError,
};
#[derive(Debug)]
pub enum EstablishedChannelError {
    PhysicalCapMismatch { physical: u32, negotiated: usize },
    UnexpectedEof,
    Framing(FramingError),
    Inbound(InboundFrameError),
    Outbound(OutboundFrameError),
}

impl Display for EstablishedChannelError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::PhysicalCapMismatch {
                physical,
                negotiated,
            } => write!(
                formatter,
                "physical frame cap {physical} does not equal negotiated cap {negotiated}"
            ),
            Self::UnexpectedEof => {
                formatter.write_str("established attempt transport ended unexpectedly")
            }
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Inbound(error) => Display::fmt(error, formatter),
            Self::Outbound(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for EstablishedChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Inbound(error) => Some(error),
            Self::Outbound(error) => Some(error),
            Self::PhysicalCapMismatch { .. } | Self::UnexpectedEof => None,
        }
    }
}

/// Owns both halves of an established attempt channel. It never exposes the
/// underlying streams, so physical and semantic poison cannot diverge.
#[derive(Debug)]
pub struct EstablishedAttemptChannel<R, W> {
    transport: DelimitedFrameChannel<R, W>,
    receiver: AttemptFrameReceiver,
    sender: OutboundHeaderAuthority,
}

impl<R: Read, W: Write> EstablishedAttemptChannel<R, W> {
    /// Binds a negotiated receiver to a physical channel.
    ///
    /// # Errors
    ///
    /// Drops and rejects a transport whose immutable cap is too small.
    pub(in crate::frame) fn from_handoff(
        mut transport: DelimitedFrameChannel<R, W>,
        receiver: AttemptFrameReceiver,
        sender: OutboundHeaderAuthority,
    ) -> Result<Self, EstablishedChannelError> {
        let physical = transport.maximum_frame_bytes();
        if usize::try_from(physical).unwrap_or(usize::MAX) != receiver.maximum_frame_bytes() {
            transport.poison();
            return Err(EstablishedChannelError::PhysicalCapMismatch {
                physical,
                negotiated: receiver.maximum_frame_bytes(),
            });
        }
        Ok(Self {
            transport,
            receiver,
            sender,
        })
    }

    #[cfg(test)]
    pub(in crate::frame) fn new(
        transport: DelimitedFrameChannel<R, W>,
        receiver: AttemptFrameReceiver,
    ) -> Result<Self, EstablishedChannelError> {
        let sender = receiver
            .outbound_authority(1)
            .map_err(EstablishedChannelError::Outbound)?;
        Self::from_handoff(transport, receiver, sender)
    }

    /// Reads and reserves one frame. Exact replays resend their bounded response
    /// before being returned to the caller.
    ///
    /// # Errors
    ///
    /// Any physical or semantic failure poisons both channel layers.
    pub fn begin_receive<F>(
        &mut self,
        clock: F,
    ) -> Result<FrameReceiveOutcome, EstablishedChannelError>
    where
        F: FnOnce() -> i64,
    {
        if self.receiver.has_pending() {
            return Err(EstablishedChannelError::Inbound(
                InboundFrameError::PendingInboundActive,
            ));
        }
        let encoded = match self.transport.read_raw() {
            Ok(value) => value,
            Err(error) => {
                self.receiver.poison();
                self.sender.poison();
                return Err(EstablishedChannelError::Framing(error));
            }
        };
        let Some(encoded) = encoded else {
            self.poison_all();
            return Err(EstablishedChannelError::UnexpectedEof);
        };
        let outcome = match self.receiver.begin_receive(&encoded, clock) {
            Ok(outcome) => outcome,
            Err(error) => {
                self.transport.poison();
                self.sender.poison();
                return Err(EstablishedChannelError::Inbound(error));
            }
        };
        if let FrameReceiveOutcome::Replay(replay) = &outcome {
            let response = match self.receiver.take_replay_response(replay) {
                Ok(response) => response,
                Err(error) => {
                    self.transport.poison();
                    self.sender.poison();
                    return Err(EstablishedChannelError::Inbound(error));
                }
            };
            if let Some(response) = response
                && let Err(error) = self.transport.write_raw(&response)
            {
                self.receiver.poison();
                self.sender.poison();
                return Err(EstablishedChannelError::Framing(error));
            }
        }
        Ok(outcome)
    }

    /// Rejects handler work and permanently invalidates both layers.
    ///
    /// # Errors
    ///
    /// Returns an error when the pending token is foreign or stale.
    pub fn reject(&mut self, pending: PendingInbound) -> Result<(), EstablishedChannelError> {
        let result = self.receiver.reject(pending);
        self.transport.poison();
        self.sender.poison();
        result.map_err(EstablishedChannelError::Inbound)
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.transport.is_poisoned() || self.receiver.is_poisoned() || self.sender.is_poisoned()
    }
}
