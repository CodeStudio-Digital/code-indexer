use agent_host_bridge::AuthenticatedHostAttemptChannels;
use napi::Result;

use crate::error;

#[derive(Debug, Clone, Copy)]
pub enum ChannelKind {
    Control,
    Data,
}

#[derive(Debug)]
pub struct NativeChannelSet;

impl NativeChannelSet {
    pub fn from_owner(_owner: AuthenticatedHostAttemptChannels) -> Result<Self> {
        Err(error::unsupported())
    }

    pub const fn maximum_frame_bytes(&self, _kind: ChannelKind) -> u32 {
        let _ = self;
        0
    }

    pub fn endpoint_id(&self, _kind: ChannelKind) -> &str {
        let _ = self;
        ""
    }

    pub fn connection_id(&self, _kind: ChannelKind) -> &str {
        let _ = self;
        ""
    }

    pub const fn peer_pid(&self, _kind: ChannelKind) -> u32 {
        let _ = self;
        0
    }

    pub const fn is_closed(&self) -> bool {
        let _ = self;
        true
    }

    pub async fn read(&self, _kind: ChannelKind, _maximum: u32) -> Result<Option<Vec<u8>>> {
        let _ = self;
        std::future::ready(Err(error::unsupported())).await
    }

    pub async fn write(&self, _kind: ChannelKind, _bytes: &[u8]) -> Result<()> {
        let _ = self;
        std::future::ready(Err(error::unsupported())).await
    }

    pub async fn close(&self) -> Result<()> {
        let _ = self;
        std::future::ready(Ok(())).await
    }
}
