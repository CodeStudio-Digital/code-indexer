use std::error::Error;
use std::fmt::{self, Display, Formatter};
use std::io::{Read, Write};

use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec, FramingError};
use crate::identity::{AttemptIdentity, ConnectionId};
use zeroize::Zeroizing;

use super::{
    super::{
        AttemptFrameReceiver, EstablishedAttemptChannel, EstablishedChannelError, FrameDirection,
        InboundFrameError, OutboundFrameError,
    },
    BootstrapError, BootstrapReceiveOutcome, BootstrapReceiver, NegotiatedReceiverSeed,
};

mod outbound;

#[derive(Debug)]
pub enum BootstrapChannelError {
    PhysicalCapMismatch { physical: u32, required: usize },
    UnexpectedEof,
    SeedChannelMismatch,
    MissingOutboundHello,
    Framing(FramingError),
    Bootstrap(BootstrapError),
    Outbound(OutboundFrameError),
    Handoff(InboundFrameError),
    Established(EstablishedChannelError),
}

impl Display for BootstrapChannelError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::PhysicalCapMismatch { physical, required } => write!(
                formatter,
                "bootstrap physical frame cap {physical} does not equal required cap {required}"
            ),
            Self::UnexpectedEof => {
                formatter.write_str("bootstrap transport ended before a Hello frame")
            }
            Self::SeedChannelMismatch => {
                formatter.write_str("negotiated seed belongs to a different bootstrap channel")
            }
            Self::MissingOutboundHello => {
                formatter.write_str("bootstrap handoff requires a committed outbound Hello")
            }
            Self::Framing(error) => Display::fmt(error, formatter),
            Self::Bootstrap(error) => Display::fmt(error, formatter),
            Self::Outbound(error) => Display::fmt(error, formatter),
            Self::Handoff(error) => Display::fmt(error, formatter),
            Self::Established(error) => Display::fmt(error, formatter),
        }
    }
}

impl Error for BootstrapChannelError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Framing(error) => Some(error),
            Self::Bootstrap(error) => Some(error),
            Self::Outbound(error) => Some(error),
            Self::Handoff(error) => Some(error),
            Self::Established(error) => Some(error),
            Self::PhysicalCapMismatch { .. }
            | Self::UnexpectedEof
            | Self::SeedChannelMismatch
            | Self::MissingOutboundHello => None,
        }
    }
}

/// One-shot owner of the bootstrap byte stream and semantic receiver.
#[derive(Debug)]
pub struct BootstrapAttemptChannel<R, W> {
    transport: DelimitedFrameChannel<R, W>,
    receiver: BootstrapReceiver,
    accepted_channel_id: Option<u64>,
    expected_identity: AttemptIdentity,
    expected_connection: ConnectionId,
    inbound_direction: FrameDirection,
    hard_cap: usize,
    outbound_hello_sent: bool,
}

impl<R: Read, W: Write> BootstrapAttemptChannel<R, W> {
    /// Binds the launch authority to a transport with the exact allocation cap.
    ///
    /// # Errors
    ///
    /// Invalid authority, caps, or a physical cap mismatch drop the transport.
    pub fn new(
        mut transport: DelimitedFrameChannel<R, W>,
        expected_identity: AttemptIdentity,
        expected_connection: ConnectionId,
        direction: FrameDirection,
        hard_cap: usize,
    ) -> Result<Self, BootstrapChannelError> {
        let receiver = match BootstrapReceiver::new(
            expected_identity.clone(),
            expected_connection.clone(),
            direction,
            hard_cap,
        ) {
            Ok(receiver) => receiver,
            Err(error) => {
                transport.poison();
                return Err(BootstrapChannelError::Bootstrap(error));
            }
        };
        let physical = transport.maximum_frame_bytes();
        if usize::try_from(physical).unwrap_or(usize::MAX) != hard_cap {
            transport.poison();
            return Err(BootstrapChannelError::PhysicalCapMismatch {
                physical,
                required: hard_cap,
            });
        }
        Ok(Self {
            transport,
            receiver,
            accepted_channel_id: None,
            expected_identity,
            expected_connection,
            inbound_direction: direction,
            hard_cap,
            outbound_hello_sent: false,
        })
    }

    /// Reads and consumes exactly one Hello frame.
    ///
    /// # Errors
    ///
    /// EOF, framing, repeated use, and semantic rejection poison the transport.
    pub fn receive<F>(&mut self, clock: F) -> Result<BootstrapReceiveOutcome, BootstrapChannelError>
    where
        F: FnOnce() -> i64,
    {
        if self.inbound_direction == FrameDirection::HostToRunner && !self.outbound_hello_sent {
            self.transport.poison();
            self.receiver.invalidate();
            return Err(BootstrapChannelError::MissingOutboundHello);
        }
        if self.receiver.is_consumed() {
            self.transport.poison();
            return Err(BootstrapChannelError::Bootstrap(BootstrapError::Consumed));
        }
        let encoded = match self.transport.read_raw() {
            Ok(Some(encoded)) => Zeroizing::new(encoded),
            Ok(None) => {
                self.receiver.invalidate();
                self.transport.poison();
                return Err(BootstrapChannelError::UnexpectedEof);
            }
            Err(error) => {
                self.receiver.invalidate();
                return Err(BootstrapChannelError::Framing(error));
            }
        };
        match self.receiver.receive(encoded.as_slice(), clock) {
            Ok(outcome) => {
                self.accepted_channel_id = Some(match &outcome {
                    BootstrapReceiveOutcome::AgentHello(hello) => hello.bootstrap_channel_id(),
                    BootstrapReceiveOutcome::HostHello(hello) => hello.bootstrap_channel_id(),
                });
                Ok(outcome)
            }
            Err(error) => {
                self.transport.poison();
                Err(BootstrapChannelError::Bootstrap(error))
            }
        }
    }

    /// Consumes this owner and narrows the same byte stream to its negotiated
    /// maximum before creating the established channel.
    ///
    /// # Errors
    ///
    /// Rejects foreign seeds, invalid capacities, or a failed transport.
    pub fn into_established(
        mut self,
        seed: NegotiatedReceiverSeed,
        replay_capacity: usize,
        total_identity_capacity: usize,
        max_replay_bytes: usize,
    ) -> Result<EstablishedAttemptChannel<R, W>, BootstrapChannelError> {
        if self.accepted_channel_id != Some(seed.bootstrap_channel_id) {
            self.transport.poison();
            return Err(BootstrapChannelError::SeedChannelMismatch);
        }
        if !self.outbound_hello_sent {
            self.transport.poison();
            return Err(BootstrapChannelError::MissingOutboundHello);
        }
        let negotiated = seed.maximum_frame_bytes;
        let receiver = match AttemptFrameReceiver::from_seed(
            seed,
            replay_capacity,
            total_identity_capacity,
            max_replay_bytes,
        ) {
            Ok(receiver) => receiver,
            Err(error) => {
                self.transport.poison();
                return Err(BootstrapChannelError::Handoff(error));
            }
        };
        let sender = receiver
            .outbound_authority(1)
            .map_err(BootstrapChannelError::Outbound)?;
        let maximum = u32::try_from(negotiated)
            .map_err(|_| BootstrapChannelError::Bootstrap(BootstrapError::InvalidHardCap))?;
        let (reader, writer) = self
            .transport
            .into_inner()
            .map_err(BootstrapChannelError::Framing)?;
        let codec = DelimitedFrameCodec::new(maximum).map_err(BootstrapChannelError::Framing)?;
        EstablishedAttemptChannel::from_handoff(
            DelimitedFrameChannel::new(codec, reader, writer),
            receiver,
            sender,
        )
        .map_err(BootstrapChannelError::Established)
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.transport.is_poisoned()
    }
}
