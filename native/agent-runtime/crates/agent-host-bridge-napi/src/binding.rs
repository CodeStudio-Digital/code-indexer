use std::fmt::{self, Debug, Formatter};
use std::sync::Arc;

use agent_host_bridge::AuthenticatedHostAttemptChannels;
use napi::Result;
use napi::bindgen_prelude::Buffer;
use napi_derive::napi;
use zeroize::Zeroizing;

use crate::error;
use crate::platform::{ChannelKind, NativeChannelSet};

#[napi]
pub struct NativeHostAttemptChannels {
    channels: Arc<NativeChannelSet>,
}

impl Debug for NativeHostAttemptChannels {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeHostAttemptChannels")
            .field("closed", &self.channels.is_closed())
            .finish_non_exhaustive()
    }
}

#[napi]
impl NativeHostAttemptChannels {
    #[napi(getter)]
    #[must_use]
    pub fn control_maximum_frame_bytes(&self) -> u32 {
        self.channels.maximum_frame_bytes(ChannelKind::Control)
    }

    #[napi(getter)]
    #[must_use]
    pub fn control_endpoint_id(&self) -> String {
        self.channels.endpoint_id(ChannelKind::Control).to_owned()
    }

    #[napi(getter)]
    #[must_use]
    pub fn control_connection_id(&self) -> String {
        self.channels.connection_id(ChannelKind::Control).to_owned()
    }

    #[napi(getter)]
    #[must_use]
    pub fn control_peer_pid(&self) -> u32 {
        self.channels.peer_pid(ChannelKind::Control)
    }

    #[napi(getter)]
    #[must_use]
    pub fn data_maximum_frame_bytes(&self) -> u32 {
        self.channels.maximum_frame_bytes(ChannelKind::Data)
    }

    #[napi(getter)]
    #[must_use]
    pub fn data_endpoint_id(&self) -> String {
        self.channels.endpoint_id(ChannelKind::Data).to_owned()
    }

    #[napi(getter)]
    #[must_use]
    pub fn data_connection_id(&self) -> String {
        self.channels.connection_id(ChannelKind::Data).to_owned()
    }

    #[napi(getter)]
    #[must_use]
    pub fn data_peer_pid(&self) -> u32 {
        self.channels.peer_pid(ChannelKind::Data)
    }

    #[napi(getter)]
    #[must_use]
    pub fn is_closed(&self) -> bool {
        self.channels.is_closed()
    }

    #[napi]
    /// Reads one bounded raw transport chunk.
    ///
    /// # Errors
    ///
    /// Fails closed for invalid limits, concurrent reads, cancellation or I/O.
    pub async fn read_control(&self, maximum_bytes: u32) -> Result<Option<Buffer>> {
        self.read(ChannelKind::Control, maximum_bytes).await
    }

    #[napi]
    /// Reads one bounded raw transport chunk.
    ///
    /// # Errors
    ///
    /// Fails closed for invalid limits, concurrent reads, cancellation or I/O.
    pub async fn read_data(&self, maximum_bytes: u32) -> Result<Option<Buffer>> {
        self.read(ChannelKind::Data, maximum_bytes).await
    }

    #[napi]
    /// Writes one bounded raw transport chunk.
    ///
    /// # Errors
    ///
    /// Fails closed for invalid chunks, concurrent writes, cancellation or I/O.
    pub async fn write_control(&self, bytes: Buffer) -> Result<()> {
        self.write(ChannelKind::Control, bytes).await
    }

    #[napi]
    /// Writes one bounded raw transport chunk.
    ///
    /// # Errors
    ///
    /// Fails closed for invalid chunks, concurrent writes, cancellation or I/O.
    pub async fn write_data(&self, bytes: Buffer) -> Result<()> {
        self.write(ChannelKind::Data, bytes).await
    }

    #[napi]
    /// Cancels pending I/O and drops both native clients.
    ///
    /// # Errors
    ///
    /// Returns an error when native cleanup cannot settle.
    pub async fn close(&self) -> Result<String> {
        self.channels.close().await?;
        Ok("closed".to_owned())
    }
}

impl NativeHostAttemptChannels {
    #[cfg(windows)]
    fn from_owner(owner: AuthenticatedHostAttemptChannels) -> Self {
        let channels = NativeChannelSet::from_owner(owner);
        Self {
            channels: Arc::new(channels),
        }
    }

    #[cfg(not(windows))]
    fn from_owner(owner: AuthenticatedHostAttemptChannels) -> Result<Self> {
        let channels = NativeChannelSet::from_owner(owner)?;
        Ok(Self {
            channels: Arc::new(channels),
        })
    }

    async fn read(&self, kind: ChannelKind, maximum: u32) -> Result<Option<Buffer>> {
        self.channels
            .read(kind, maximum)
            .await
            .map(|value| value.map(Into::into))
    }

    async fn write(&self, kind: ChannelKind, mut bytes: Buffer) -> Result<()> {
        let payload = Zeroizing::new(bytes.to_vec());
        bytes.fill(0);
        self.channels.write(kind, payload.as_slice()).await
    }
}

/// Opens and owns both authenticated attempt transports.
///
/// # Errors
///
/// Rejects malformed requests, durable divergence and physical peer failures.
#[allow(
    clippy::trailing_empty_array,
    reason = "generated napi-rs callback layout is controlled by the binding macro"
)]
#[napi]
pub async fn open_host_attempt_bridge(mut request: Buffer) -> Result<NativeHostAttemptChannels> {
    let encoded = request.to_vec();
    request.fill(0);
    let owner =
        AuthenticatedHostAttemptChannels::open(encoded).map_err(|source| error::bridge(&source))?;
    #[cfg(windows)]
    return Ok(NativeHostAttemptChannels::from_owner(owner));
    #[cfg(not(windows))]
    NativeHostAttemptChannels::from_owner(owner)
}
