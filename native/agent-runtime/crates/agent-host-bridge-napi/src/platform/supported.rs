use agent_host_bridge::AuthenticatedHostAttemptChannels;
use napi::Result;
use std::fmt::{self, Debug, Formatter};

use crate::error;

mod authority;
mod duplex;
mod supervisor;

use authority::CloseAuthority;
use duplex::NativeDuplex;
pub use supervisor::NativeSupervisorSet;

pub const MAX_TRANSPORT_CHUNK_BYTES: u32 = 64 * 1024;

#[derive(Debug, Clone, Copy)]
pub enum ChannelKind {
    Control,
    Data,
}

pub struct NativeChannelSet {
    control: NativeDuplex,
    data: NativeDuplex,
    close: CloseAuthority,
}

impl NativeChannelSet {
    pub fn from_owner(owner: AuthenticatedHostAttemptChannels) -> Self {
        let (control, data) = owner.into_channels();
        let close = CloseAuthority::new();
        Self {
            control: NativeDuplex::new_control(control, close.clone()),
            data: NativeDuplex::new_data(data, close.clone()),
            close,
        }
    }

    pub const fn maximum_frame_bytes(&self, kind: ChannelKind) -> u32 {
        self.channel(kind).maximum_frame_bytes()
    }

    pub fn endpoint_id(&self, kind: ChannelKind) -> &str {
        self.channel(kind).endpoint_id()
    }

    pub fn connection_id(&self, kind: ChannelKind) -> &str {
        self.channel(kind).connection_id()
    }

    pub const fn peer_pid(&self, kind: ChannelKind) -> u32 {
        self.channel(kind).peer_pid()
    }

    pub fn is_closed(&self) -> bool {
        self.close.is_closed()
    }

    pub async fn read(&self, kind: ChannelKind, maximum: u32) -> Result<Option<Vec<u8>>> {
        if maximum == 0 || maximum > MAX_TRANSPORT_CHUNK_BYTES {
            self.close.begin();
            return Err(error::invalid("native Host bridge read cap is invalid"));
        }
        self.channel(kind).read(maximum).await
    }

    pub async fn write(&self, kind: ChannelKind, bytes: &[u8]) -> Result<()> {
        if bytes.is_empty() || bytes.len() > MAX_TRANSPORT_CHUNK_BYTES as usize {
            self.close.begin();
            return Err(error::invalid("native Host bridge write chunk is invalid"));
        }
        self.channel(kind).write(bytes).await
    }

    pub async fn close(&self) -> Result<()> {
        self.close.begin();
        self.control.close().await;
        self.data.close().await;
        Ok(())
    }

    const fn channel(&self, kind: ChannelKind) -> &NativeDuplex {
        match kind {
            ChannelKind::Control => &self.control,
            ChannelKind::Data => &self.data,
        }
    }
}

impl Debug for NativeChannelSet {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeChannelSet")
            .field("closed", &self.is_closed())
            .finish_non_exhaustive()
    }
}

impl Drop for NativeChannelSet {
    fn drop(&mut self) {
        self.close.begin();
    }
}
