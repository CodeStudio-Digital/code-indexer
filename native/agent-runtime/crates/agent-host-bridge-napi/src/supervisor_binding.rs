use std::fmt::{self, Debug, Formatter};
use std::sync::Arc;

use agent_host_bridge::AuthenticatedHostSupervisorChannel;
use napi::Result;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use zeroize::Zeroizing;

use crate::error;
use crate::platform::NativeSupervisorSet;

#[napi(object)]
#[derive(Debug)]
pub struct NativeHostSupervisorCloseReceipt {
    pub process_id: u32,
    pub exit_code: u32,
    pub forced: bool,
}

#[napi]
pub struct NativeHostSupervisorChannel {
    channel: Arc<NativeSupervisorSet>,
}

impl Debug for NativeHostSupervisorChannel {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeHostSupervisorChannel")
            .field("closed", &self.channel.is_closed())
            .finish_non_exhaustive()
    }
}

#[napi]
impl NativeHostSupervisorChannel {
    #[napi(getter)]
    #[must_use]
    pub fn management_connection_id(&self) -> String {
        self.channel.connection_id().to_owned()
    }

    #[napi(getter)]
    #[must_use]
    pub fn management_maximum_frame_bytes(&self) -> u32 {
        self.channel.maximum_frame_bytes()
    }

    #[napi(getter)]
    #[must_use]
    pub fn supervisor_process_id(&self) -> u32 {
        self.channel.peer_pid()
    }

    #[napi(getter)]
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.channel.is_closed()
    }

    #[napi]
    /// Reads at most the caller-supplied bounded number of management bytes.
    ///
    /// # Errors
    ///
    /// Rejects an invalid cap, concurrent read, closed owner or transport error.
    pub async fn read_management(&self, maximum_bytes: u32) -> Result<Option<Buffer>> {
        self.channel
            .read(maximum_bytes)
            .await
            .map(|value| value.map(Into::into))
    }

    #[napi]
    /// Writes one bounded management transport chunk and scrubs the JS buffer.
    ///
    /// # Errors
    ///
    /// Rejects an empty or oversized chunk, concurrent write, closed owner or
    /// transport error.
    pub async fn write_management(&self, mut bytes: Buffer) -> Result<()> {
        let payload = Zeroizing::new(bytes.to_vec());
        bytes.fill(0);
        self.channel.write(payload.as_slice()).await
    }

    #[napi]
    /// Closes the transport, settles the process Job and returns reap evidence.
    ///
    /// # Errors
    ///
    /// Returns a cleanup error when the owned process tree cannot be reaped.
    pub async fn close(&self) -> Result<NativeHostSupervisorCloseReceipt> {
        let evidence = self.channel.close().await?;
        Ok(NativeHostSupervisorCloseReceipt {
            process_id: evidence.process_id,
            exit_code: evidence.exit_code,
            forced: evidence.forced,
        })
    }
}

impl NativeHostSupervisorChannel {
    #[cfg(windows)]
    fn from_owner(owner: AuthenticatedHostSupervisorChannel) -> Self {
        Self {
            channel: Arc::new(NativeSupervisorSet::from_owner(owner)),
        }
    }
}

/// Launches and owns one authenticated process-real supervisor.
///
/// # Errors
///
/// Rejects malformed authority, package drift, bootstrap mismatch, peer
/// mismatch, deadline or cleanup failure.
#[allow(
    clippy::trailing_empty_array,
    reason = "generated napi-rs callback layout is controlled by the binding macro"
)]
#[napi]
pub async fn open_host_supervisor_bridge(
    mut request: Buffer,
) -> Result<NativeHostSupervisorChannel> {
    let encoded = request.to_vec();
    request.fill(0);
    let owner = AuthenticatedHostSupervisorChannel::open(encoded)
        .await
        .map_err(|source| error::supervisor(&source))?;
    #[cfg(windows)]
    return Ok(NativeHostSupervisorChannel::from_owner(owner));
    #[cfg(not(windows))]
    {
        drop(owner);
        Err(error::unsupported())
    }
}
