//! Supervisor-side facade for the bounded management handshake.
//!
//! Construction does not start the supervisor executable; normal `main`
//! remains fail-closed until process lifecycle integration is complete.

use std::fmt::{self, Debug, Formatter};
use std::io::{Read, Write};

use agent_protocol::framing::{DelimitedFrameChannel, DelimitedFrameCodec};
use agent_protocol::generated::v1 as wire;
use agent_protocol::identity::ConnectionId;
use agent_protocol::management_channel::{
    BootstrapManagementChannel, ManagementBootstrapHello, ManagementChannelError,
    ManagementDirection, ManagementReplayLimits,
};
use agent_protocol::management_frame::MANAGEMENT_FRAME_MAX_BYTES;
use zeroize::Zeroize;

mod async_service;
mod channel;
mod cleanup_pump;
mod driver;
mod envelope_receipt;
mod launch_receipt;
mod online_lifecycle;

pub use async_service::{
    SupervisorAsyncService, SupervisorAsyncServiceAdvance, SupervisorAsyncServiceOutcome,
    SupervisorAsyncServiceStatus, SupervisorManagementTerminal,
};
pub use channel::SupervisorManagementChannel;
pub use cleanup_pump::{
    CleanupPumpConfig, CleanupPumpConfigError, CleanupPumpOutcome, CleanupPumpStartError,
    CleanupPumpStartReason, HardRestartReason, HardRestartRequired, SupervisorCleanupOwner,
    SupervisorCleanupPump,
};
pub use driver::{
    AdmissionClosureReason, CleanupDriveReport, CleanupPhase, CleanupStateError,
    FailClosedProtectedLaunchProvisioner, PendingProtectedLaunch, PreparedProtectedLaunch,
    ProtectedLaunchCleanupOwner, ProtectedLaunchCleanupPort, ProtectedLaunchCleanupProof,
    ProtectedLaunchCompletion, ProtectedLaunchCompletionFailure, ProtectedLaunchPeerAuthority,
    ProtectedLaunchPeerAuthorityError, ProtectedLaunchPhysicalFacts, ProtectedLaunchProvisionError,
    ProtectedLaunchProvisionPort, ProtectedLaunchReceipt, ProtectedLaunchRequest,
    SupervisorDriverCreateError, SupervisorDriverError, SupervisorDriverState,
    SupervisorDriverStep, SupervisorLifecycleCore, SupervisorPhysicalDriver, TrustedRunnerConfig,
    TrustedRunnerConfigError, TrustedRunnerProvenance,
};
#[cfg(windows)]
pub use driver::{
    WindowsProtectedLaunchCancellation, WindowsProtectedLaunchCleanup, WindowsProtectedLaunchError,
    WindowsProtectedLaunchProvisioner,
};
pub(in crate::management) use envelope_receipt::ManagementEnvelopeReceipt;
pub use launch_receipt::SupervisorLaunchReceipt;
pub use online_lifecycle::{
    OnlineLifecycleAdvance, OnlineLifecycleShutdown, OnlineLifecycleShutdownError,
    OnlineLifecycleShutdownHandle, SupervisorLifecycleClock, SupervisorLifecycleClockError,
    SupervisorLifecycleOwner, SupervisorOnlineLifecycle, SupervisorOnlineLifecycleTimer,
    SystemSupervisorLifecycleClock, TokioSupervisorLifecycleTimer,
};

pub struct SupervisorManagementBootstrap<R, W> {
    channel: BootstrapManagementChannel<R, W>,
    launch_receipt: SupervisorLaunchReceipt,
}

impl<R: Read, W: Write> Debug for SupervisorManagementBootstrap<R, W> {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorManagementBootstrap")
            .field("channel", &self.channel)
            .field("launch_receipt", &self.launch_receipt)
            .finish()
    }
}

impl<R: Read, W: Write> SupervisorManagementBootstrap<R, W> {
    /// Creates the supervisor side with the connection ID provisioned before
    /// any byte is read.
    ///
    /// # Errors
    ///
    /// Rejects an invalid physical cap or exhausted channel authority.
    pub fn new(
        reader: R,
        writer: W,
        expected_connection: ConnectionId,
        expected_management_session_token: Vec<u8>,
        launch_receipt: SupervisorLaunchReceipt,
    ) -> Result<Self, ManagementChannelError> {
        let maximum = u32::try_from(MANAGEMENT_FRAME_MAX_BYTES)
            .map_err(|_| ManagementChannelError::InvalidNegotiatedMaximum)?;
        let codec = DelimitedFrameCodec::new(maximum)?;
        let transport = DelimitedFrameChannel::new(codec, reader, writer);
        let expected_supervisor_launch_nonce = launch_receipt.launch_nonce_copy()?;
        Ok(Self {
            channel: BootstrapManagementChannel::new(
                transport,
                expected_connection,
                expected_supervisor_launch_nonce,
                expected_management_session_token,
                ManagementDirection::HostToSupervisor,
            )?,
            launch_receipt,
        })
    }

    /// Receives the host-owned first Hello.
    ///
    /// # Errors
    ///
    /// Physical or semantic bootstrap failures poison the owned stream.
    pub fn receive_host_hello(&mut self) -> Result<(), ManagementChannelError> {
        match self.channel.receive()? {
            ManagementBootstrapHello::HostSupervisorAccepted => Ok(()),
            ManagementBootstrapHello::SupervisorAccepted => {
                Err(ManagementChannelError::WrongBootstrapPayload)
            }
        }
    }

    /// Sends the supervisor-owned second Hello.
    ///
    /// # Errors
    ///
    /// Invalid order, compatibility, or transport failure poisons the stream.
    pub fn send_supervisor_hello(&mut self) -> Result<(), ManagementChannelError> {
        let Some(policy) = self.channel.policy().cloned() else {
            return self
                .channel
                .send_supervisor_hello(&wire::SupervisorHello::default());
        };
        let mut hello = match self.launch_receipt.take_supervisor_hello(&policy) {
            Ok(hello) => hello,
            Err(error) => {
                let _ = self
                    .channel
                    .send_supervisor_hello(&wire::SupervisorHello::default());
                return Err(error);
            }
        };
        let result = self.channel.send_supervisor_hello(&hello);
        hello.launch_nonce.as_mut_slice().zeroize();
        result
    }

    /// Hands the same stream to the established transactional channel.
    ///
    /// # Errors
    ///
    /// Incomplete bootstrap or invalid replay bounds fail closed.
    pub fn into_established(
        self,
        limits: ManagementReplayLimits,
    ) -> Result<SupervisorManagementChannel<R, W>, ManagementChannelError> {
        Ok(SupervisorManagementChannel::new(
            self.channel.into_established(limits)?,
        ))
    }

    #[must_use]
    pub const fn is_poisoned(&self) -> bool {
        self.channel.is_poisoned()
    }
}

#[cfg(test)]
mod tests;
