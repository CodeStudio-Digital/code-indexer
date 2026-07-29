use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use crate::identity::ConnectionId;

use super::channel::EstablishedManagementChannel;
use super::clock::ManagementClockAuthority;
use super::receiver::ManagementReceiver;
use super::sender::ManagementOutboundAuthority;
use super::{
    ManagementChannelError, ManagementDirection, ManagementReceiverContext, ManagementReplayLimits,
    management_hard_cap,
};

mod inbound;
mod outbound;
mod policy;
mod validation;

pub use policy::ManagementSessionPolicy;
pub(in crate::management_channel) use policy::{
    BootstrapSelection, SecretDigest, seal_nonce, seal_token, validate_host_hello,
    validate_supervisor_hello,
};
pub(in crate::management_channel) use validation::{ReceivedBootstrap, validate_wire_bootstrap};

static NEXT_BOOTSTRAP_CHANNEL_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManagementBootstrapHello {
    HostSupervisorAccepted,
    SupervisorAccepted,
}

/// Sole owner of the physical management stream from the first Hello through
/// established transactional operation.
///
/// External callers cannot inject an observation clock:
///
/// ```compile_fail
/// use std::io::{Read, Write};
/// use agent_protocol::management_channel::BootstrapManagementChannel;
///
/// fn bypass<R: Read, W: Write>(channel: &mut BootstrapManagementChannel<R, W>) {
///     let _ = channel.receive(|| 1);
/// }
/// ```
pub struct BootstrapManagementChannel<R, W> {
    transport: DelimitedFrameChannel<R, W>,
    expected_connection: ConnectionId,
    inbound_direction: ManagementDirection,
    channel_id: u64,
    expected_supervisor_launch_nonce: SecretDigest,
    expected_management_session_token: SecretDigest,
    clock: ManagementClockAuthority,
    selection: Option<BootstrapSelection>,
    inbound_message_id: Option<String>,
    inbound_received: bool,
    outbound_sent: bool,
    poisoned: bool,
}

impl<R: Read, W: Write> Debug for BootstrapManagementChannel<R, W> {
    fn fmt(&self, f: &mut Formatter<'_>) -> fmt::Result {
        f.debug_struct("BootstrapManagementChannel")
            .field("maximum_frame_bytes", &self.transport.maximum_frame_bytes())
            .field("transport_poisoned", &self.transport.is_poisoned())
            .field("expected_connection", &self.expected_connection)
            .field("inbound_direction", &self.inbound_direction)
            .field("channel_id", &self.channel_id)
            .field("selection", &self.selection)
            .field("expected_supervisor_launch_nonce", &"[REDACTED]")
            .field("expected_management_session_token", &"[REDACTED]")
            .field("clock", &"ManagementClockAuthority")
            .field("inbound_received", &self.inbound_received)
            .field("inbound_message_id", &self.inbound_message_id)
            .field("outbound_sent", &self.outbound_sent)
            .field("poisoned", &self.poisoned)
            .finish()
    }
}

impl<R: Read, W: Write> BootstrapManagementChannel<R, W> {
    /// Binds a pre-provisioned connection to an exact 64 KiB physical cap.
    ///
    /// # Errors
    ///
    /// Rejects a transport with any other allocation cap.
    pub fn new(
        mut transport: DelimitedFrameChannel<R, W>,
        expected_connection: ConnectionId,
        expected_supervisor_launch_nonce: Vec<u8>,
        expected_management_session_token: Vec<u8>,
        inbound_direction: ManagementDirection,
    ) -> Result<Self, ManagementChannelError> {
        let expected_supervisor_launch_nonce = seal_nonce(expected_supervisor_launch_nonce)?;
        let expected_management_session_token = seal_token(expected_management_session_token)?;
        let clock = ManagementClockAuthority::system()?;
        let required = management_hard_cap();
        if usize::try_from(transport.maximum_frame_bytes()).unwrap_or(usize::MAX) != required {
            let physical = transport.maximum_frame_bytes();
            transport.poison();
            return Err(ManagementChannelError::PhysicalCapMismatch { physical, required });
        }
        let channel_id = NEXT_BOOTSTRAP_CHANNEL_ID
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
                value.checked_add(1)
            })
            .map_err(|_| ManagementChannelError::ChannelIdExhausted)?;
        Ok(Self {
            transport,
            expected_connection,
            inbound_direction,
            channel_id,
            expected_supervisor_launch_nonce,
            expected_management_session_token,
            clock,
            selection: None,
            inbound_message_id: None,
            inbound_received: false,
            outbound_sent: false,
            poisoned: false,
        })
    }

    /// Narrows the same stream to the selected limit and creates both
    /// established sequence authorities.
    ///
    /// # Errors
    ///
    /// Incomplete bootstrap, invalid limits, or a poisoned stream fail closed.
    pub fn into_established(
        mut self,
        limits: ManagementReplayLimits,
    ) -> Result<EstablishedManagementChannel<R, W>, ManagementChannelError> {
        if self.poisoned || !self.inbound_received || !self.outbound_sent {
            self.poison_all();
            return Err(ManagementChannelError::WrongBootstrapOrder);
        }
        let selection = self
            .selection
            .take()
            .ok_or(ManagementChannelError::WrongBootstrapOrder)?;
        let bootstrap_message_id = self
            .inbound_message_id
            .take()
            .ok_or(ManagementChannelError::SeedChannelMismatch)?;
        let context = ManagementReceiverContext {
            protocol: selection.protocol,
            connection: self.expected_connection.clone(),
            direction: self.inbound_direction,
            maximum_frame_bytes: selection.maximum_frame_bytes,
            bootstrap_message_id,
        };
        let receiver = ManagementReceiver::from_context(context, limits)?;
        let sender = ManagementOutboundAuthority::new(
            selection.protocol,
            self.expected_connection,
            self.inbound_direction.reverse(),
            selection.maximum_frame_bytes,
            selection.policy.frame_limits().write_timeout_ms,
            selection.policy.frame_limits().max_in_flight_frames,
            selection.policy.frame_limits().max_in_flight_bytes,
        )?;
        let (reader, writer) = self.transport.into_inner()?;
        let maximum = u32::try_from(selection.maximum_frame_bytes)
            .map_err(|_| ManagementChannelError::InvalidNegotiatedMaximum)?;
        let codec = DelimitedFrameCodec::new(maximum)?;
        EstablishedManagementChannel::from_handoff(
            DelimitedFrameChannel::new(codec, reader, writer),
            receiver,
            sender,
            selection.policy,
            self.clock,
        )
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.poisoned || self.transport.is_poisoned()
    }

    #[must_use]
    pub fn policy(&self) -> Option<&ManagementSessionPolicy> {
        self.selection.as_ref().map(|selection| &selection.policy)
    }

    fn fail<T>(&mut self, error: ManagementChannelError) -> Result<T, ManagementChannelError> {
        self.poison_all();
        Err(error)
    }

    fn poison_all(&mut self) {
        self.poisoned = true;
        self.transport.poison();
    }
}
