use std::fmt::{self, Debug, Formatter};
#[cfg(windows)]
use std::time::Duration;

#[cfg(windows)]
use agent_platform::containment::ContainmentPort;
#[cfg(windows)]
use agent_platform::windows::{WindowsContainment, WindowsJobGroup};
#[cfg(not(windows))]
use zeroize::Zeroizing;

use super::HostSupervisorBridgeError;
#[cfg(windows)]
use super::request::HostSupervisorLaunchPlan;

#[cfg(windows)]
pub type HostSupervisorVerifiedStream = agent_platform::windows::ipc::VerifiedWindowsEndpointStream;

#[cfg(not(windows))]
#[derive(Debug)]
pub struct HostSupervisorVerifiedStream;

pub struct HostSupervisorBinding {
    connection_id: String,
    maximum_frame_bytes: u32,
    peer_pid: u32,
}

impl HostSupervisorBinding {
    #[must_use]
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    #[must_use]
    pub const fn maximum_frame_bytes(&self) -> u32 {
        self.maximum_frame_bytes
    }

    #[must_use]
    pub const fn peer_pid(&self) -> u32 {
        self.peer_pid
    }
}

impl Debug for HostSupervisorBinding {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HostSupervisorBinding")
            .field("connection_id", &"[REDACTED]")
            .field("maximum_frame_bytes", &self.maximum_frame_bytes)
            .field("peer_pid", &self.peer_pid)
            .finish()
    }
}

pub struct AuthenticatedHostSupervisorChannel {
    binding: HostSupervisorBinding,
    stream: HostSupervisorVerifiedStream,
    process: SupervisorProcessOwner,
}

impl AuthenticatedHostSupervisorChannel {
    /// Opens the native management listener, verifies package artifacts,
    /// launches the supervisor with private bootstrap handles and returns only
    /// after physical Ready and peer PID agree.
    ///
    /// # Errors
    ///
    /// Rejects malformed authority, package drift, bootstrap mismatch,
    /// unverified peers, startup timeout or cleanup failure.
    pub async fn open(encoded: Vec<u8>) -> Result<Self, HostSupervisorBridgeError> {
        #[cfg(windows)]
        {
            let plan = HostSupervisorLaunchPlan::decode(encoded)?;
            super::windows::open(plan).await
        }
        #[cfg(not(windows))]
        {
            let _encoded = Zeroizing::new(encoded);
            std::future::ready(Err(HostSupervisorBridgeError::UnsupportedPlatform)).await
        }
    }

    #[must_use]
    pub const fn binding(&self) -> &HostSupervisorBinding {
        &self.binding
    }

    #[must_use]
    pub fn into_parts(
        self,
    ) -> (
        HostSupervisorBinding,
        HostSupervisorVerifiedStream,
        SupervisorProcessOwner,
    ) {
        (self.binding, self.stream, self.process)
    }

    #[cfg(windows)]
    pub(super) const fn from_parts(
        binding: HostSupervisorBinding,
        stream: HostSupervisorVerifiedStream,
        process: SupervisorProcessOwner,
    ) -> Self {
        Self {
            binding,
            stream,
            process,
        }
    }
}

impl Debug for AuthenticatedHostSupervisorChannel {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AuthenticatedHostSupervisorChannel")
            .field("binding", &self.binding)
            .field("stream", &"[AUTHENTICATED]")
            .field("process", &self.process)
            .finish()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorCloseEvidence {
    pub process_id: u32,
    pub exit_code: u32,
    pub forced: bool,
}

pub struct SupervisorProcessOwner {
    #[cfg(windows)]
    group: Option<WindowsJobGroup>,
}

impl SupervisorProcessOwner {
    #[cfg(windows)]
    pub(super) const fn new(group: WindowsJobGroup) -> Self {
        Self { group: Some(group) }
    }

    #[cfg(windows)]
    pub(super) fn request_termination(&self) -> Result<(), HostSupervisorBridgeError> {
        let group = self
            .group
            .as_ref()
            .ok_or_else(|| HostSupervisorBridgeError::Cleanup("process owner consumed".into()))?;
        WindowsContainment::new()
            .terminate_group(group, 0xFFFF_FF31)
            .map_err(|source| HostSupervisorBridgeError::Cleanup(source.to_string()))
    }

    /// Waits for cooperative exit first, then terminates the Job and proves it
    /// empty before releasing the final ownership handle.
    ///
    /// # Errors
    ///
    /// Returns a cleanup error when the Job cannot be terminated or reaped.
    #[cfg(windows)]
    pub fn close(mut self) -> Result<SupervisorCloseEvidence, HostSupervisorBridgeError> {
        let group = self
            .group
            .take()
            .ok_or_else(|| HostSupervisorBridgeError::Cleanup("process owner consumed".into()))?;
        let containment = WindowsContainment::new();
        match containment.reap_group(group, Duration::from_secs(5)) {
            Ok(evidence) => Ok(SupervisorCloseEvidence {
                process_id: evidence.process_id().0,
                exit_code: evidence.exit_code(),
                forced: false,
            }),
            Err(failure) => {
                containment
                    .terminate_group(&failure.group, 0xFFFF_FF32)
                    .map_err(|source| HostSupervisorBridgeError::Cleanup(source.to_string()))?;
                let evidence = containment
                    .reap_group(failure.group, Duration::from_secs(5))
                    .map_err(|failure| {
                        HostSupervisorBridgeError::Cleanup(failure.error.to_string())
                    })?;
                Ok(SupervisorCloseEvidence {
                    process_id: evidence.process_id().0,
                    exit_code: evidence.exit_code(),
                    forced: true,
                })
            }
        }
    }

    #[cfg(not(windows))]
    /// Returns the platform error without attempting process cleanup.
    ///
    /// # Errors
    ///
    /// Always returns [`HostSupervisorBridgeError::UnsupportedPlatform`].
    pub const fn close(self) -> Result<SupervisorCloseEvidence, HostSupervisorBridgeError> {
        Err(HostSupervisorBridgeError::UnsupportedPlatform)
    }
}

impl Debug for SupervisorProcessOwner {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SupervisorProcessOwner")
            .field("owned", &{
                #[cfg(windows)]
                {
                    self.group.is_some()
                }
                #[cfg(not(windows))]
                {
                    false
                }
            })
            .finish_non_exhaustive()
    }
}

#[cfg(windows)]
impl Drop for SupervisorProcessOwner {
    fn drop(&mut self) {
        if let Some(group) = self.group.as_ref() {
            let _ = WindowsContainment::new().terminate_group(group, 0xFFFF_FF33);
        }
    }
}

impl HostSupervisorBinding {
    #[cfg(windows)]
    pub(super) const fn new(
        connection_id: String,
        maximum_frame_bytes: u32,
        peer_pid: u32,
    ) -> Self {
        Self {
            connection_id,
            maximum_frame_bytes,
            peer_pid,
        }
    }
}
